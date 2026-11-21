// The window uses the panel's own fonts and world icons, copied from public/ so they live in one place.
const ASSETS: [&str; 5] = ["RuneScape-Plain-12.ttf", "RuneScape-Bold-12.ttf", "members-world.png", "free-world.png", "hardcore-world.png"];

fn main() {
    let assets = std::path::Path::new("../ui/assets");
    std::fs::create_dir_all(assets).expect("create ui/assets");
    for file in ASSETS {
        let source = format!("../../../public/{file}");
        println!("cargo:rerun-if-changed={source}");
        std::fs::copy(&source, assets.join(file)).unwrap_or_else(|e| panic!("copy {source}: {e}"));
    }
    // The node that builds the app also runs the panel it starts (shared.rs).
    println!("cargo:rerun-if-env-changed=TSPS_NODE");
    tauri_build::build()
}
