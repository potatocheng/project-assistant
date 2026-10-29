//! Feishu's official SDK app-update flow: registration device grant with addons.
//! Wire format: github.com/larksuite/node-sdk/scene/registration/{index,addons}.ts
//! Checked 2026-10-28. No tenant token or app-management scope is needed.
use super::*;
use flate2::{write::GzEncoder, Compression};

#[derive(Clone)]
pub(super) struct Pending {
    id: String,
    device_code: String,
    pub(super) url: String,
    pub(super) expires_at: i64,
    generation: String,
    interval: u64,
}

impl Api {
    pub(super) fn registration(&self, fields: &[(&str, &str)]) -> Result<Value> {
        let (status, value) =
            self.response_value(self.client.post(&self.registration).form(fields).send())?;
        // RFC 8628 uses HTTP 400 for these states. Never retry this POST blindly.
        if (status.is_success() || status.as_u16() == 400)
            && matches!(
                value["error"].as_str(),
                Some("authorization_pending" | "slow_down" | "access_denied" | "expired_token")
            )
        {
            return Ok(value);
        }
        self.checked(status, value)
    }
}

impl Pending {
    pub(super) fn new(value: &Value, saved: &Saved) -> Result<Self> {
        let invalid = || error("FEISHU_RESPONSE", "飞书权限申请响应无效，请重新连接");
        let device_code = value["device_code"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 8192)
            .ok_or_else(invalid)?;
        let mut url = Url::parse(
            value["verification_uri_complete"]
                .as_str()
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        if !is_confirmation_url(&url) {
            return Err(invalid());
        }
        // preset:false prevents the PersonalAgent template adding unrelated scopes.
        // Application permissions, OAuth scopes and the UI all use SCOPES.
        let addons =
            json!({"preset":false,"scopes":{"user":SCOPES.split_whitespace().collect::<Vec<_>>()}});
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(addons.to_string().as_bytes())?;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(gzip.finish()?);
        let pairs: Vec<_> = url
            .query_pairs()
            .filter(|(k, _)| {
                !matches!(
                    k.as_ref(),
                    "addons" | "clientID" | "createOnly" | "from" | "source" | "tp"
                )
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs).extend_pairs([
            ("addons", encoded.as_str()),
            ("clientID", saved.app_id.as_str()),
            ("from", "sdk"),
            ("source", "project-assistant"),
            ("tp", "sdk"),
        ]);
        Ok(Self {
            id: id(),
            device_code: device_code.into(),
            url: url.into(),
            expires_at: timestamp() + value["expires_in"].as_i64().unwrap_or(600).clamp(1, 1800),
            generation: saved.generation.clone(),
            interval: value["interval"].as_u64().unwrap_or(5).clamp(1, 60),
        })
    }
    fn output(&self) -> Value {
        json!({"authorizationUrl":self.url,"stage":"permissions","expiresAt":iso(self.expires_at)})
    }
}

fn is_confirmation_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("accounts.feishu.cn")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

impl Inner {
    pub(super) fn begin_permissions(self: &Arc<Self>) -> Result<Value> {
        let saved = {
            let state = lock(&self.state)?;
            if let Some(p) = state
                .permissions
                .as_ref()
                .filter(|p| p.expires_at > timestamp())
            {
                return Ok(p.output());
            }
            if let Some(p) = state
                .authorization
                .as_ref()
                .filter(|p| p.expires_at > timestamp())
            {
                return Ok(
                    json!({"authorizationUrl":p.url,"stage":"account","expiresAt":iso(p.expires_at)}),
                );
            }
            if state.saved.app_id.is_empty() || state.saved.app_secret.is_none() {
                return Err(error("FEISHU_CONFIG", "请先保存飞书 App ID 和 App Secret"));
            }
            state.saved.clone()
        };
        let response = self.api.registration(&[
            ("action", "begin"),
            ("archetype", "PersonalAgent"),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ])?;
        let pending = Pending::new(&response, &saved)?;
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        if self.stopped.load(Ordering::SeqCst) || state.saved.generation != saved.generation {
            return Err(error(
                "FEISHU_CANCELLED",
                "权限申请期间设置已变化，请重新连接",
            ));
        }
        // Concurrent clicks reuse the already published request.
        if let Some(p) = state
            .permissions
            .as_ref()
            .filter(|p| p.expires_at > timestamp())
        {
            return Ok(p.output());
        }
        if state
            .authorization
            .as_ref()
            .is_some_and(|p| p.expires_at > timestamp())
        {
            return Err(error("FEISHU_AUTH_BUSY", "个人授权已开始，请完成当前授权"));
        }
        let output = pending.output();
        state.permissions = Some(pending.clone());
        state.last_error = None;
        let weak = Arc::downgrade(self);
        if let Err(e) = thread::Builder::new()
            .name("feishu-permission-confirmation".into())
            .spawn(move || permission_worker(weak, pending))
        {
            state.permissions = None;
            return Err(e.into());
        }
        Ok(output)
    }

    fn permission_current(&self, pending: &Pending) -> bool {
        !self.stopped.load(Ordering::SeqCst)
            && self.state.lock().is_ok_and(|s| {
                s.saved.generation == pending.generation
                    && s.permissions.as_ref().is_some_and(|p| p.id == pending.id)
            })
    }

    // Returns the generation to which the subsequent personal OAuth must belong.
    pub(super) fn finish_permissions(&self, pending: &Pending, response: &Value) -> Result<String> {
        let _credential = lock(&self.credential_gate)?;
        let _gate = lock(&self.send_gate)?;
        let mut state = lock(&self.state)?;
        if self.stopped.load(Ordering::SeqCst)
            || state.saved.generation != pending.generation
            || state
                .permissions
                .as_ref()
                .is_none_or(|p| p.id != pending.id)
        {
            return Err(error("FEISHU_CANCELLED", "飞书连接已取消或设置已变化"));
        }
        if response["client_id"].as_str() != Some(state.saved.app_id.as_str()) {
            return Err(error(
                "FEISHU_APP_MISMATCH",
                "飞书确认的应用与当前应用不同，请重新连接",
            ));
        }
        let secret = response["client_secret"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 16_384 && !s.contains(['\r', '\n']))
            .ok_or_else(|| error("FEISHU_RESPONSE", "飞书未返回有效应用凭据，请重新连接"))?;
        let mut next = state.saved.clone();
        next.app_secret = Some(secret.into());
        next.generation = id();
        self.persist(&next)?;
        let generation = next.generation.clone();
        state.saved = next;
        state.permissions = None;
        state.last_error = None;
        Ok(generation)
    }

    fn permission_failed(&self, pending: &Pending, e: &AppError) {
        if let Ok(mut state) = self.state.lock() {
            if state.saved.generation == pending.generation
                && state
                    .permissions
                    .as_ref()
                    .is_some_and(|p| p.id == pending.id)
            {
                state.permissions = None;
                state.last_error = Some(e.message.clone());
            }
        }
    }
}

fn permission_worker(weak: Weak<Inner>, mut pending: Pending) {
    loop {
        // Short slices let disconnect, shutdown and settings changes cancel promptly.
        for _ in 0..pending.interval {
            thread::sleep(Duration::from_secs(1));
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if !inner.permission_current(&pending) {
                return;
            }
            if timestamp() >= pending.expires_at {
                inner.permission_failed(
                    &pending,
                    &error(
                        "FEISHU_PERMISSION_EXPIRED",
                        "飞书权限确认已过期，请重新点击连接",
                    ),
                );
                return;
            }
        }
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let result = inner
            .api
            .registration(&[("action", "poll"), ("device_code", &pending.device_code)]);
        if !inner.permission_current(&pending) {
            return;
        }
        if timestamp() >= pending.expires_at {
            inner.permission_failed(
                &pending,
                &error(
                    "FEISHU_PERMISSION_EXPIRED",
                    "飞书权限确认已过期，请重新点击连接",
                ),
            );
            return;
        }
        let result = result.and_then(|response| {
            match response["error"].as_str() {
                Some("authorization_pending") => Ok(false),
                Some("slow_down") => {
                    pending.interval = (pending.interval + 5).min(300);
                    Ok(false)
                }
                Some("access_denied") => Err(error(
                    "FEISHU_OAUTH_DENIED",
                    "你已取消飞书权限申请，可以随时重新连接",
                )),
                Some("expired_token") => Err(error(
                    "FEISHU_PERMISSION_EXPIRED",
                    "飞书权限确认已过期，请重新点击连接",
                )),
                _ => {
                    let generation = inner.finish_permissions(&pending, &response)?;
                    // Keep app confirmation separate from personal consent. Never treat
                    // an app-management confirmation as authorization to read or send.
                    if let Err(e) = inner.begin_authorization_for(Some(&generation)) {
                        let mut state = lock(&inner.state)?;
                        if state.saved.generation == generation {
                            state.last_error = Some(e.message);
                        }
                    }
                    Ok(true)
                }
            }
        });
        match result {
            Ok(true) => return,
            Ok(false) => (),
            Err(e) => {
                inner.permission_failed(&pending, &e);
                return;
            }
        }
    }
}
