use crate::{ai::AiConfig, id, AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, net::IpAddr, path::Path};

// Deliberately has no Debug implementation: the only serialization target is the private file.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub output_format: String,
    pub timeout_seconds: u64,
    pub auto_extract: bool,
    pub remote_consent: bool,
    pub api_key: Option<String>,
    pub revision: String,
}
impl Default for SavedSettings {
    fn default() -> Self {
        Self {
            provider: "openai_compatible".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            output_format: "json_object".into(),
            timeout_seconds: 60,
            auto_extract: false,
            remote_consent: false,
            api_key: None,
            revision: "unconfigured".into(),
        }
    }
}
impl SavedSettings {
    pub fn config(&self) -> AiConfig {
        AiConfig {
            provider: self.provider.clone(),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            output_format: self.output_format.clone(),
            timeout_seconds: self.timeout_seconds,
        }
    }
    pub fn is_remote(&self) -> bool {
        let Ok(url) = reqwest::Url::parse(&self.base_url) else {
            return true;
        };
        let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
        host != "localhost"
            && !host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    }
    pub fn validate_credentials(&self) -> Result<()> {
        crate::ai::validate_config(&self.config())?;
        if self.provider == "openai_compatible"
            && self.api_key.as_ref().is_none_or(|key| key.is_empty())
        {
            return Err(AppError::new("AI_NOT_CONFIGURED", "请先保存模型 API Key"));
        }
        Ok(())
    }
    pub fn validate_material_access(&self) -> Result<()> {
        self.validate_credentials()?;
        if self.is_remote() && !self.remote_consent {
            return Err(AppError::new(
                "REMOTE_CONSENT_REQUIRED",
                "请先确认允许将资料发送到已设置的模型服务",
            ));
        }
        Ok(())
    }
    pub fn public(&self) -> Value {
        json!({"provider":self.provider,"baseUrl":self.base_url,"model":self.model,"outputFormat":self.output_format,
            "timeoutSeconds":self.timeout_seconds,"autoExtract":self.auto_extract,"remoteConsent":self.remote_consent,
            "configured":self.validate_material_access().is_ok(),"hasApiKey":self.api_key.as_ref().is_some_and(|key|!key.is_empty())})
    }
}

pub(crate) fn private_directory(root: &Path) -> Result<std::path::PathBuf> {
    let directory = root.join("secrets");
    if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::new("SECRET_PATH", "秘密配置目录不能是符号链接"));
    }
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    protect_windows_directory(&directory)?;
    Ok(directory)
}

#[cfg(windows)]
fn protect_windows_directory(directory: &Path) -> Result<()> {
    use std::{
        collections::HashSet,
        os::windows::process::CommandExt,
        sync::{Mutex, OnceLock},
    };
    static PROTECTED: OnceLock<Mutex<HashSet<std::path::PathBuf>>> = OnceLock::new();
    let mut protected = PROTECTED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| AppError::new("SECRET_PATH", "无法检查秘密目录权限"))?;
    if protected.contains(directory) {
        return Ok(());
    }
    let system = std::path::PathBuf::from(
        std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
    )
    .join("System32");
    let identity = std::process::Command::new(system.join("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(0x08000000)
        .output()?;
    let identity = String::from_utf8_lossy(&identity.stdout);
    let sid = identity
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim_matches('"');
    if !sid.starts_with("S-1-")
        || !sid
            .chars()
            .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
    {
        return Err(AppError::new(
            "SECRET_PATH",
            "无法确定当前 Windows 账号，未保存凭据",
        ));
    }
    let access = std::process::Command::new(system.join("icacls.exe"))
        .arg(directory)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("*{sid}:(OI)(CI)F"),
            "*S-1-5-18:(OI)(CI)F",
        ])
        .creation_flags(0x08000000)
        .output()?;
    if !access.status.success() {
        return Err(AppError::new(
            "SECRET_PATH",
            "无法将秘密目录限定为当前 Windows 账号访问",
        ));
    }
    protected.insert(directory.to_path_buf());
    Ok(())
}
pub(crate) fn load(root: &Path) -> Result<SavedSettings> {
    let directory = private_directory(root)?;
    let path = directory.join("ai-settings.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedSettings::default())
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return Err(AppError::new("SECRET_CONFIG", "秘密配置文件无效"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| AppError::new("SECRET_CONFIG", "模型配置无法读取，请重新配置"))
}
pub(crate) fn save(root: &Path, p: &Value) -> Result<(SavedSettings, bool)> {
    let old = load(root)?;
    let provider = crate::required(p, "provider")?.to_owned();
    let raw_url = crate::required(p, "baseUrl")?.trim();
    let url =
        reqwest::Url::parse(raw_url).map_err(|_| AppError::new("AI_CONFIG", "模型服务地址无效"))?;
    let base_url = url.as_str().trim_end_matches('/').to_owned();
    let model = crate::required(p, "model")?.trim().to_owned();
    let output_format = crate::required(p, "outputFormat")?.to_owned();
    let timeout_seconds = p["timeoutSeconds"]
        .as_u64()
        .filter(|value| (1..=300).contains(value))
        .ok_or_else(|| AppError::new("AI_CONFIG", "超时需在 1 到 300 秒之间"))?;
    let auto_extract = p["autoExtract"]
        .as_bool()
        .ok_or_else(|| AppError::new("AI_CONFIG", "autoExtract 必须为布尔值"))?;
    let remote_consent = p["remoteConsent"]
        .as_bool()
        .ok_or_else(|| AppError::new("AI_CONFIG", "remoteConsent 必须为布尔值"))?;
    let api_key = match p.get("apiKey") {
        Some(Value::String(key)) => {
            if key.len() > 16 * 1024 || key.contains(['\r', '\n']) {
                return Err(AppError::new("AI_CONFIG", "API Key 格式无效"));
            }
            let key = key.trim();
            if key.is_empty() {
                None
            } else {
                Some(key.to_owned())
            }
        }
        None if provider == old.provider && base_url == old.base_url => old.api_key.clone(),
        None => None,
        _ => return Err(AppError::new("AI_CONFIG", "API Key 必须是字符串")),
    };
    let mut next = SavedSettings {
        provider,
        base_url,
        model,
        output_format,
        timeout_seconds,
        auto_extract,
        remote_consent,
        api_key,
        revision: old.revision.clone(),
    };
    crate::ai::validate_config(&next.config())?;
    if next.auto_extract {
        next.validate_material_access()?;
    }
    let changed = serde_json::to_vec(&old).ok() != serde_json::to_vec(&next).ok();
    if !changed {
        return Ok((next, false));
    }
    next.revision = id();
    let directory = private_directory(root)?;
    let temporary = directory.join(format!(".{}.tmp", id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let bytes = serde_json::to_vec(&next)
        .map_err(|_| AppError::new("SECRET_CONFIG", "模型配置保存失败"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    fs::rename(&temporary, directory.join("ai-settings.json"))?;
    crate::sync_directory(&directory)?;
    Ok((next, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        json!({"provider":"openai_compatible","baseUrl":"https://api.deepseek.com/","model":"deepseek-flash","outputFormat":"json_object","timeoutSeconds":60,"autoExtract":false,"remoteConsent":true,"apiKey":"fixture-private-key"})
    }
    #[test]
    fn private_key_is_redacted_preserved_for_same_endpoint_and_cleared_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let (mut settings, _) = save(dir.path(), &payload()).unwrap();
        assert!(settings.public()["configured"].as_bool().unwrap());
        assert!(!settings
            .public()
            .to_string()
            .contains("fixture-private-key"));
        let mut update = payload();
        update.as_object_mut().unwrap().remove("apiKey");
        update["model"] = json!("another-model");
        settings = save(dir.path(), &update).unwrap().0;
        assert!(settings.api_key.is_some());
        update["baseUrl"] = json!("https://another.example.com/v1");
        settings = save(dir.path(), &update).unwrap().0;
        assert!(settings.api_key.is_none());
        assert_eq!(settings.public()["configured"], false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("secrets"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(dir.path().join("secrets/ai-settings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn cleared_key_is_not_restored_by_an_omitted_field_and_consent_gates_material() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = payload();
        p["remoteConsent"] = json!(false);
        let config = save(dir.path(), &p).unwrap().0;
        assert!(config.validate_credentials().is_ok());
        assert!(config.validate_material_access().is_err());
        p["apiKey"] = json!("");
        save(dir.path(), &p).unwrap();
        p.as_object_mut().unwrap().remove("apiKey");
        assert!(save(dir.path(), &p).unwrap().0.api_key.is_none());
        p["autoExtract"] = json!(true);
        assert!(save(dir.path(), &p).is_err());
    }
}
