fn main() {
    println!("cargo:rerun-if-env-changed=VERSIONDOCK_GITHUB_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=VERSIONDOCK_ALLOW_INSECURE_PROVIDER_HOSTS");
    tauri_build::build()
}
