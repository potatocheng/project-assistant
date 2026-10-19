use project_assistant_core::{Engine, Request};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn main() {
    let root = std::env::args_os()
        .nth(1)
        .or_else(|| std::env::var_os("PM_WORKSPACE"))
        .unwrap_or_else(|| "work/pm-host-data".into());
    let engine = match Engine::open(root) {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    };
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin: {error}");
                break;
            }
        };
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                let request = serde_json::from_value::<Request>(value.clone());
                match request {
                    Ok(request) => match engine.execute(request) {
                        Ok(data) => json!({"id":value["id"],"ok":true,"data":data,"error":null}),
                        Err(error) => {
                            json!({"id":value["id"],"ok":false,"data":null,"error":error})
                        }
                    },
                    Err(error) => {
                        json!({"id":value["id"],"ok":false,"data":null,"error":{"code":"INVALID_REQUEST","message":error.to_string()}})
                    }
                }
            }
            Err(error) => {
                json!({"id":null,"ok":false,"data":null,"error":{"code":"INVALID_JSON","message":error.to_string()}})
            }
        };
        if writeln!(stdout, "{response}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}
