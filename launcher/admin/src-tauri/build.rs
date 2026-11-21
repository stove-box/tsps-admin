fn main() {
    // The node that builds the app also runs the panel it starts (shared.rs).
    println!("cargo:rerun-if-env-changed=TSPS_NODE");
    tauri_build::build()
}
