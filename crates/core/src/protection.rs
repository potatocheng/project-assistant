//! Versioned authenticated envelopes. Keys/passwords never enter SQLite or logs.
use crate::{AppError, Result};
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use std::{fs, path::Path, sync::Mutex};
use zeroize::Zeroizing;
const BACKUP_MAGIC: &[u8; 8] = b"PABK0001";
const SECRET_MAGIC: &[u8; 8] = b"PASE0001";
static SECRET_LOCK: Mutex<()> = Mutex::new(());
pub(crate) fn guard() -> Result<std::sync::MutexGuard<'static, ()>> {
    SECRET_LOCK.lock().map_err(|_| failure())
}
fn failure() -> AppError {
    AppError::new("DECRYPT_FAILED", "密码不正确、系统凭据不可用或文件已损坏")
}
fn cipher(key: &[u8]) -> Result<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| failure())
}
fn seal(magic: &[u8; 8], key: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher(key)?
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: plain,
                aad: magic,
            },
        )
        .map_err(|_| failure())?;
    let mut out = magic.to_vec();
    out.extend_from_slice(&nonce);
    out.extend(encrypted);
    Ok(out)
}
fn open(magic: &[u8; 8], key: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 36 || &bytes[..8] != magic {
        return Err(failure());
    }
    cipher(key)?
        .decrypt(
            Nonce::from_slice(&bytes[8..20]),
            aes_gcm::aead::Payload {
                msg: &bytes[20..],
                aad: magic,
            },
        )
        .map_err(|_| failure())
}
fn derive(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    if !(12..=1024).contains(&password.chars().count()) {
        return Err(AppError::new(
            "PASSWORD_LENGTH",
            "备份密码需为12–1024个字符",
        ));
    }
    let mut key = Zeroizing::new([0; 32]);
    let params = scrypt::Params::new(17, 8, 1, 32).map_err(|_| failure())?;
    scrypt::scrypt(password.as_bytes(), salt, &params, key.as_mut()).map_err(|_| failure())?;
    Ok(key)
}
pub(crate) fn encrypt_backup(plain: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive(password, &salt)?;
    let encrypted = seal(BACKUP_MAGIC, key.as_ref(), plain)?;
    let mut out = encrypted[..8].to_vec();
    out.extend(salt);
    out.extend(&encrypted[8..]);
    Ok(out)
}
pub(crate) fn decrypt_backup(bytes: &[u8], password: &str) -> Result<Vec<u8>> {
    if bytes.len() < 52 || &bytes[..8] != BACKUP_MAGIC {
        return Err(failure());
    }
    let key = derive(password, &bytes[8..24])?;
    let mut envelope = bytes[..8].to_vec();
    envelope.extend(&bytes[24..]);
    open(BACKUP_MAGIC, key.as_ref(), &envelope)
}
fn entry(root: &Path) -> Result<keyring::Entry> {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = root;
        Err(AppError::new(
            "SECURE_STORE_UNAVAILABLE",
            "此构建暂未启用当前系统的凭据存储",
        ))
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        keyring::Entry::new(
            "com.projectassistant.workspace-key",
            &crate::hash(root.to_string_lossy().as_bytes()),
        )
        .map_err(|_| failure())
    }
}
fn key(root: &Path, create: bool) -> Result<Zeroizing<Vec<u8>>> {
    let entry = entry(root)?;
    match entry.get_secret() {
        Ok(secret) if secret.len() == 32 => Ok(Zeroizing::new(secret)),
        Err(keyring::Error::NoEntry) if create => {
            let mut key = Zeroizing::new(vec![0; 32]);
            OsRng.fill_bytes(key.as_mut());
            entry.set_secret(&key).map_err(|_| failure())?;
            if entry.get_secret().map_err(|_| failure())? != *key {
                return Err(failure());
            }
            Ok(key)
        }
        _ => Err(failure()),
    }
}
pub(crate) fn enabled(root: &Path) -> bool {
    root.join("secrets/system-store.enabled").is_file()
}
pub(crate) fn encode_secret(root: &Path, bytes: &[u8]) -> Result<Vec<u8>> {
    if enabled(root) {
        seal(SECRET_MAGIC, &key(root, false)?, bytes)
    } else {
        Ok(bytes.to_vec())
    }
}
pub(crate) fn decode_secret(root: &Path, bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.starts_with(SECRET_MAGIC) {
        open(SECRET_MAGIC, &key(root, false)?, bytes)
    } else {
        Ok(bytes.to_vec())
    }
}
pub(crate) fn enable(root: &Path) -> Result<()> {
    let _lock = guard()?;
    let directory = crate::settings::private_directory(root)?;
    let key = key(root, true)?;
    // Each file has an independently recognizable envelope. A crash halfway
    // through migration remains readable and repeating migration is safe.
    for name in ["ai-settings.json", "feishu-settings.json"] {
        let path = directory.join(name);
        if !path.exists() {
            continue;
        }
        let meta = fs::symlink_metadata(&path)?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(failure());
        }
        let bytes = Zeroizing::new(fs::read(&path)?);
        if bytes.starts_with(SECRET_MAGIC) {
            open(SECRET_MAGIC, &key, &bytes)?;
            continue;
        }
        let encrypted = seal(SECRET_MAGIC, &key, &bytes)?;
        if open(SECRET_MAGIC, &key, &encrypted)? != *bytes {
            return Err(failure());
        }
        let temporary = directory.join(format!(".secure-{}.tmp", crate::id()));
        fs::write(&temporary, encrypted)?;
        fs::File::open(&temporary)?.sync_all()?;
        fs::rename(&temporary, &path)?;
    }
    fs::write(directory.join("system-store.enabled"), b"1")?;
    crate::sync_directory(&directory)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_envelope_rejects_tamper_and_wrong_key() {
        let key = [1u8; 32];
        let plain = b"synthetic private material";
        let mut encoded = seal(SECRET_MAGIC, &key, plain).unwrap();
        assert_eq!(open(SECRET_MAGIC, &key, &encoded).unwrap(), plain);
        assert!(open(SECRET_MAGIC, &[2; 32], &encoded).is_err());
        encoded[25] ^= 1;
        assert!(open(SECRET_MAGIC, &key, &encoded).is_err());
    }
    #[test]
    fn encrypted_backup_roundtrip_and_password_validation() {
        assert!(encrypt_backup(b"x", "short").is_err());
        let encrypted = encrypt_backup(b"fixture zip", "fixture-strong-password").unwrap();
        assert_eq!(
            decrypt_backup(&encrypted, "fixture-strong-password").unwrap(),
            b"fixture zip"
        );
        assert!(decrypt_backup(&encrypted, "different-strong-password").is_err());
    }
}
