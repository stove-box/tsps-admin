// The starting screen uses the panel's own fonts, copied from public/ so they live in one place.
const ASSETS: [&str; 2] = ["RuneScape-Plain-12.ttf", "RuneScape-Bold-12.ttf"];

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
