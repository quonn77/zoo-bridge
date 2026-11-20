// Embeds the bundled sidecar (sidecar-bundle/main.mjs, made by
// `npm run bundle` in sidecar/) into the plugin: OpenIDEA gives plugin code
// no path to its own package files, so the plugin writes this file to its
// data directory and runs it. Without a bundle the embedded file is empty and
// the sidecar script must be set in the plugin's settings (development).

use std::{env, fs, path::Path};

fn main() {
    let src = Path::new("sidecar-bundle").join("main.mjs");
    println!("cargo:rerun-if-changed={}", src.display());
    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("sidecar.mjs");
    let text = fs::read_to_string(&src).unwrap_or_default();
    if text.is_empty() {
        println!("cargo:warning=no sidecar bundle (run `npm run bundle` in sidecar/): the plugin needs its sidecarScript setting");
    }
    fs::write(&out, text).expect("write embedded sidecar");
}
