use crate::{actor_call, ai, memory, settings, Message, Request, Result};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) struct Worker {
    last: Mutex<Instant>,
    generation: AtomicU64,
    stopped: AtomicBool,
    force: AtomicBool,
}

impl Worker {
    pub(crate) fn start(sender: mpsc::SyncSender<Message>, root: PathBuf) -> Result<Arc<Self>> {
        let state = Arc::new(Self {
            last: Mutex::new(Instant::now()),
            generation: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            force: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&state);
        thread::Builder::new()
            .name("memory-maintenance".into())
            .spawn(move || loop {
                thread::sleep(Duration::from_secs(2));
                let Some(state) = weak.upgrade() else { return };
                if state.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let call = |command: &str, payload| {
                    actor_call(
                        &sender,
                        Request {
                            command: command.into(),
                            payload,
                        },
                    )
                };
                let Ok(status) = call("_memory_policy", json!({})) else {
                    return;
                };
                let force = state.force.swap(false, Ordering::SeqCst);
                let idle = state.last.lock().is_ok_and(|t| {
                    t.elapsed().as_secs()
                        >= status["settings"]["idleSeconds"].as_u64().unwrap_or(120)
                });
                if (!force && (status["settings"]["enabled"] != true || !idle))
                    || status["callsToday"].as_i64().unwrap_or(0)
                        >= status["settings"]["dailyCalls"].as_i64().unwrap_or(100)
                {
                    continue;
                }
                let activity = state.generation.load(Ordering::SeqCst);
                let (tx, rx) = mpsc::channel();
                if sender.send(Message::ClaimMaintenance(tx)).is_err() {
                    return;
                }
                let task = match rx.recv() {
                    Ok(Ok(Some(task))) => task,
                    _ => continue,
                };
                let (run, guard, job) = match &task {
                    memory::Task::Extract {
                        run, guard, job, ..
                    } => (run.clone(), guard.clone(), Some(job.clone())),
                    memory::Task::Compare { run, guard, .. } => (run.clone(), guard.clone(), None),
                };
                let alive = || {
                    !state.stopped.load(Ordering::SeqCst)
                        && state.generation.load(Ordering::SeqCst) == activity
                        && call("_memory_alive", guard.clone()).is_ok_and(|v| v == true)
                };
                let reserve =
                    || alive() && call("_memory_reserve", guard.clone()).is_ok_and(|v| v == true);
                let output = match task {
                    memory::Task::Extract {
                        job, epoch, task, ..
                    } => {
                        let result = ai::extract(
                            &task.settings.config(),
                            task.settings.api_key.as_deref(),
                            &task.segments,
                            |done, total| {
                                if !alive() {
                                    return false;
                                }
                                let (tx, rx) = mpsc::channel();
                                if sender
                                    .send(Message::ProgressExtract(
                                        job.clone(),
                                        epoch,
                                        task.generation,
                                        done,
                                        total,
                                        tx,
                                    ))
                                    .is_err()
                                    || !rx.recv().unwrap_or(false)
                                {
                                    return false;
                                }
                                done == total || reserve()
                            },
                        );
                        memory::Output::Extract(job, epoch, task.generation, result)
                    }
                    memory::Task::Compare { snapshot, .. } => {
                        let result = if let Ok(Some(local)) = memory::compare_locally(&snapshot) {
                            Ok(local)
                        } else if reserve() {
                            settings::load(&root)
                                .and_then(|config| memory::compare(&config, &snapshot))
                        } else {
                            Err(crate::AppError::new(
                                "IDLE_INTERRUPTED",
                                "整理暂停或已达调用上限",
                            ))
                        };
                        memory::Output::Compare(snapshot, result)
                    }
                };
                if alive() {
                    let _ = sender.send(Message::CompleteMaintenance(
                        run,
                        guard,
                        output,
                        state.clone(),
                        activity,
                    ));
                } else {
                    let _ = call("_memory_cancel", json!({"run":run,"job":job}));
                }
            })?;
        Ok(state)
    }
    pub(crate) fn touch(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = Instant::now()
        };
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub(crate) fn is_current(&self, generation: u64) -> bool {
        !self.stopped.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }
    pub(crate) fn run_now(&self) {
        self.force.store(true, Ordering::SeqCst);
    }
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.touch();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;
    use serde_json::Value;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn call(engine: &Engine, command: &str, payload: Value) -> Value {
        engine
            .execute(Request {
                command: command.into(),
                payload,
            })
            .unwrap()
    }
    fn wait(engine: &Engine, predicate: impl Fn(&Value) -> bool) {
        let start = Instant::now();
        loop {
            let status = call(engine, "get_memory_maintenance", json!({}));
            if predicate(&status) {
                return;
            }
            assert!(
                start.elapsed() < Duration::from_secs(12),
                "timed out: {status}"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }
    #[test]
    fn actual_idle_worker_pauses_on_activity_then_resumes_through_evidence_to_memory() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let counted = calls.clone();
        let server = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut block = [0; 4096];
                let end = loop {
                    let n = stream.read(&mut block).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&block[..n]);
                    if let Some(i) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .unwrap()
                    .1
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                while bytes.len() < end + length {
                    let n = stream.read(&mut block).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&block[..n]);
                }
                let body: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                let input: Value =
                    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                let segment = input["segments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["text"].as_str().unwrap().contains("一期周五发布"))
                    .unwrap();
                let output = json!({"candidates":[{"kind":"decision","content":"一期周五发布","evidence":[{"segmentId":segment["id"],"quote":"一期周五发布"}]}],"taskCandidates":[]});
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                let body=json!({"choices":[{"message":{"content":output.to_string()},"finish_reason":"stop"}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                stream.flush().unwrap();
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
                while stream.read(&mut block).is_ok_and(|n| n > 0) {}
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path()).unwrap();
        let project = call(&engine, "create_project", json!({"name":"自动整理验收"}));
        call(
            &engine,
            "save_ai_settings",
            json!({"provider":"openai_compatible","baseUrl":base,"apiKey":"fixture-only","model":"fixture-memory","outputFormat":"json_object","timeoutSeconds":10,"autoExtract":false,"remoteConsent":false}),
        );
        call(
            &engine,
            "save_memory_maintenance",
            json!({"enabled":true,"idleSeconds":30,"dailyCalls":10,"autoNew":true}),
        );
        actor_call(&engine.inner.sender,Request{command:"_ingest_remote".into(),payload:json!({"projectId":project["id"],"title":"指定群讨论","text":"一期周五发布","origin":{"provider":"feishu_chat","remoteId":"oc_a:om_a","remoteRevision":"1","url":"https://team.feishu.cn","author":"成员A","occurredAt":"2026-10-19T00:00:00Z","fetchedAt":crate::now()}})}).unwrap();
        engine.schedule();
        thread::sleep(Duration::from_millis(2200));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "active app must not extract"
        );
        *engine.inner.maintenance.last.lock().unwrap() = Instant::now() - Duration::from_secs(31);
        // UI polling must not postpone idle maintenance.
        call(&engine, "get_feishu_sources", json!({}));
        started_rx.recv_timeout(Duration::from_secs(8)).unwrap();
        call(&engine, "memory_activity", json!({}));
        release_tx.send(()).unwrap();
        wait(&engine, |s| {
            s["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["status"] == "cancelled")
        });
        assert!(call(&engine, "get_state", json!({}))["proposals"]
            .as_array()
            .unwrap()
            .is_empty());
        *engine.inner.maintenance.last.lock().unwrap() = Instant::now() - Duration::from_secs(31);
        wait(&engine, |s| {
            s["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["kind"] == "compare" && r["status"] == "succeeded")
        });
        let state = call(&engine, "get_state", json!({}));
        assert_eq!(state["memories"].as_array().unwrap().len(), 1);
        assert_eq!(state["memories"][0]["content"], "一期周五发布");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            call(&engine, "get_memory_maintenance", json!({}))["callsToday"],
            2
        );
        drop(engine);
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
    }
}
