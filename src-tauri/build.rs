use std::{env, process::Command};

#[cfg(target_os = "macos")]
fn compile_now_playing_bridge() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is not set");
    let lib_path = format!("{out_dir}/libneedle_now_playing.a");
    let status = Command::new("swiftc")
        .args([
            "-static",
            "-emit-library",
            "-framework",
            "MediaPlayer",
            "-framework",
            "AppKit",
            "-o",
            &lib_path,
            "src/now_playing.swift",
        ])
        .status()
        .expect("Failed to compile macOS Now Playing bridge");

    if !status.success() {
        panic!("Swift compilation failed for macOS Now Playing bridge");
    }

    println!("cargo:rustc-link-search=native={out_dir}");
    println!("cargo:rustc-link-lib=static=needle_now_playing");
    println!("cargo:rustc-link-lib=framework=MediaPlayer");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rerun-if-changed=src/now_playing.swift");
}

fn main() {
    #[cfg(target_os = "macos")]
    compile_now_playing_bridge();

    tauri_build::build()
}
