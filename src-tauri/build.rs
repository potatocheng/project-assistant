fn main() {
    println!("cargo:rerun-if-env-changed=PROJECT_ASSISTANT_UPDATE_URL");
    println!("cargo:rerun-if-env-changed=PROJECT_ASSISTANT_UPDATE_PUBKEY");
    tauri_build::build();
}
