// Reference: https://github.com/xtool-org/xtool/blob/main/Sources/XToolSupport/SDKBuilder.swift
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager, Window};

use crate::builder::crossplatform::{
    linux_path, linux_temp_dir, remove_dir_all, set_executable, symlink,
};
use crate::builder::swift::{validate_toolchain, SwiftBin};
use crate::operation::Operation;
use tauri::path::BaseDirectory;
use unxip_rs::{reader::XipReader, UnxipError};

#[cfg(not(target_os = "windows"))]
use sdkmover::copy_developer;

#[cfg(target_os = "windows")]
use crate::windows::windows_to_wsl_path;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Toolset release from https://github.com/xtool-org/darwin-tools-linux-llvm.
/// Keep in sync with xtool's `SDKBuilder.darwinToolsVersion`.
const DARWIN_TOOLS_VERSION: &str = "1.1.0";

/// Release from https://github.com/xtool-org/OpenAppleMacros, which provides
/// implementations for the macros that only exist in Apple's (macOS-only)
/// toolchain (SwiftUI/Previews/FoundationModels macros).
/// Keep in sync with xtool's `SDKBuilder.oamVersion`.
const OPEN_APPLE_MACROS_VERSION: &str = "1.3.0";

/// Keep in sync with xtool's `SDKBuilder.oamLibraries`.
const OPEN_APPLE_MACROS_LIBRARIES: [&str; 3] = [
    "FoundationModelsMacros",
    "PreviewsMacros",
    "SwiftUIMacros",
];

/// Bump this whenever the layout/content of the generated bundle changes, so
/// tools that cache a darwin SDK by this string rebuild it.
/// Mirrors xtool's `SDKBuilder.sdkEpoch`.
const SDK_EPOCH: u32 = 2;

/// Linux architecture of the machine that the built SDK runs on (or of WSL,
/// when running on Windows).
fn toolset_arch() -> Result<&'static str, String> {
    if cfg!(target_arch = "x86_64") {
        Ok("x86_64")
    } else if cfg!(target_arch = "aarch64") {
        Ok("aarch64")
    } else {
        Err("Unsupported architecture".to_string())
    }
}

/// Value written to `darwin-sdk-version.txt`. Same shape as xtool's
/// `SDKBuilder.currentSDKVersion`.
fn darwin_sdk_version() -> String {
    format!(
        "epoch={},darwinTools={},oam={}",
        SDK_EPOCH, DARWIN_TOOLS_VERSION, OPEN_APPLE_MACROS_VERSION
    )
}

/// lld has no `-r` (merge object files) mode, but SPM's SwiftBuild backend uses
/// it on Darwin. We therefore install a shell trampoline as `ld64.lld` that
/// redirects `-r` invocations to `llvm-lib` and forwards everything else to the
/// real linker (`bin/orig/ld64.lld`). Taken from xtool.
///
/// Stored line by line so the generated script never inherits the line endings
/// of the checkout.
const LD64_TRAMPOLINE: &[&str] = &[
    "#!/bin/sh",
    "",
    "set -eu",
    "",
    "case \"$0\" in",
    "    */*) script_path=\"$0\" ;;",
    "    *) script_path=\"$(command -v \"$0\")\" ;;",
    "esac",
    "case \"$script_path\" in",
    "    /*) script_dir=\"${script_path%/*}\"; [ -n \"$script_dir\" ] || script_dir=\"/\" ;;",
    "    */*) script_dir=\"${script_path%/*}\" ;;",
    "    *) script_dir=\".\" ;;",
    "esac",
    "bin_dir=\"$(CDPATH= cd -P \"$script_dir\" && pwd -P)\"",
    "",
    "find_argument_value() {",
    "    argument_name=\"$1\"",
    "    shift",
    "",
    "    while [ \"$#\" -gt 0 ]; do",
    "        if [ \"$1\" = \"$argument_name\" ]; then",
    "            shift",
    "            if [ \"$#\" -gt 0 ]; then",
    "                argument_value=\"$1\"",
    "                return 0",
    "            fi",
    "            return 1",
    "        fi",
    "        shift",
    "    done",
    "",
    "    return 1",
    "}",
    "",
    "relocatable=",
    "for argument do",
    "    if [ \"$argument\" = \"-r\" ]; then",
    "        relocatable=1",
    "    fi",
    "done",
    "",
    "if [ -n \"$relocatable\" ]; then",
    "    missing_argument=",
    "",
    "    if find_argument_value -filelist \"$@\"; then",
    "        filelist=\"$argument_value\"",
    "    else",
    "        missing_argument=1",
    "    fi",
    "    if find_argument_value -dependency_info \"$@\"; then",
    "        dependency_info=\"$argument_value\"",
    "    else",
    "        missing_argument=1",
    "    fi",
    "    if find_argument_value -o \"$@\"; then",
    "        output=\"$argument_value\"",
    "    else",
    "        missing_argument=1",
    "    fi",
    "",
    "    if [ -n \"$missing_argument\" ]; then",
    "        echo \"ld64.lld trampoline could not process arguments.\" >&2",
    "        echo \"Please file an issue at https://github.com/nab138/CrossCode/issues\" >&2",
    "        echo \"  Arguments: $@\" >&2",
    "        exit 2",
    "    fi",
    "",
    "    exec \"$bin_dir/llvm-lib\" -static \\",
    "        -filelist \"$filelist\" \\",
    "        -dependency_info \"$dependency_info\" \\",
    "        -o \"$output\"",
    "fi",
    "",
    "exec \"$bin_dir/orig/ld64.lld\" \"$@\"",
    "",
];

fn ld64_trampoline() -> String {
    LD64_TRAMPOLINE.join("\n")
}

#[tauri::command]
pub async fn install_sdk_operation(
    app: AppHandle,
    window: Window,
    xcode_path: String,
    toolchain_path: String,
    is_dir: bool,
) -> Result<(), String> {
    let op = Operation::new("install_sdk".to_string(), &window);
    op.start("create_stage")?;
    let work_dir = op
        .fail_if_err("create_stage", linux_temp_dir())?
        .join("crosscode")
        .join("DarwinSDKBuild");
    let res = install_sdk_internal(
        app,
        xcode_path,
        toolchain_path,
        work_dir.clone(),
        is_dir,
        &op,
    )
    .await;
    op.start("cleanup")?;
    let cleanup_result = if work_dir.exists() {
        remove_dir_all(&work_dir)
    } else {
        Ok(())
    };

    let cleanup_result_for_match = cleanup_result
        .as_ref()
        .map(|_| ())
        .map_err(|e| format!("{}", e));

    let cleanup_result = op.fail_if_err_map("cleanup", cleanup_result, |e| {
        format!("Failed to remove temp dir: {}", e)
    });

    if cleanup_result.is_ok() {
        op.complete("cleanup")?;
    }

    match (res, cleanup_result_for_match) {
        (Err(main_err), Err(cleanup_err)) => Err(format!(
            "{main_err} (additionally, failed to clean up temp dir: {cleanup_err})"
        )),
        (Err(main_err), _) => Err(main_err),
        (Ok(_), Err(cleanup_err)) => Err(format!(
            "Install succeeded, but failed to clean up temp dir: {cleanup_err}"
        )),
        (Ok(val), Ok(_)) => Ok(val),
    }
}
async fn install_sdk_internal(
    app: AppHandle,
    xcode_path: String,
    toolchain_path: String,
    work_dir: PathBuf,
    is_dir: bool,
    op: &Operation<'_>,
) -> Result<(), String> {
    if xcode_path.is_empty() || (!xcode_path.ends_with(".xip") && !is_dir) {
        return op.fail("create_stage", "Xcode not found".to_string());
    }
    if toolchain_path.is_empty() {
        return op.fail("create_stage", "Toolchain not found".to_string());
    }
    if !validate_toolchain(&toolchain_path) {
        return op.fail("create_stage", "Invalid toolchain path".to_string());
    }

    let swift_bin = SwiftBin::new(&toolchain_path);
    if swift_bin.is_err() {
        return op.fail("create_stage", "Invalid toolchain path".to_string());
    }
    let swift_bin = swift_bin.unwrap();
    let output = swift_bin.output(&["sdk", "remove", "darwin"]);
    if let Ok(output) = output {
        if !output.status.success() && output.status.code() != Some(1) {
            return op.fail(
                "create_stage",
                format!(
                    "Failed to remove existing darwin SDK: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
            );
        }
    }

    let output_dir = work_dir.join("darwin.artifactbundle");
    if output_dir.exists() {
        op.fail_if_err_map("create_stage", remove_dir_all(&output_dir), |e| {
            format!("Failed to remove existing output directory: {}", e)
        })?;
    }
    op.fail_if_err_map("create_stage", fs::create_dir_all(&output_dir), |e| {
        format!("Failed to create output directory: {}", e)
    })?;

    op.move_on("create_stage", "install_toolset")?;
    op.fail_if_err("install_toolset", install_toolset(&output_dir).await)?;
    op.complete("install_toolset")?;

    // Apple's macro implementations only exist in the macOS toolchain, so we
    // ship xtool's OpenAppleMacros server instead (see `install_macros`).
    op.start("install_macros")?;
    op.fail_if_err("install_macros", install_macros(&output_dir).await)?;
    op.complete("install_macros")?;

    let dev = install_developer(app, &output_dir, &xcode_path, is_dir, op).await?;
    op.start("write_metadata")?;

    let iphone_os_sdk = op.fail_if_err("write_metadata", sdk(&dev, "iPhoneOS"))?;
    let mac_os_sdk = op.fail_if_err("write_metadata", sdk(&dev, "MacOSX"))?;
    let iphone_simulator_sdk = op.fail_if_err("write_metadata", sdk(&dev, "iPhoneSimulator"))?;

    let info = "{
    \"schemaVersion\": \"1.0\",
    \"artifacts\": {
        \"darwin\": {
            \"type\": \"swiftSDK\",
            \"version\": \"0.0.1\",
            \"variants\": [
                {
                    \"path\": \".\",
                    \"supportedTriples\": [\"aarch64-unknown-linux-gnu\", \"x86_64-unknown-linux-gnu\"]
                }
            ]
        }
    }
}";
    op.fail_if_err_map(
        "write_metadata",
        fs::write(output_dir.join("info.json"), info),
        |e| format!("Failed to write info.json: {}", e),
    )?;

    let toolset = "{
    \"schemaVersion\": \"1.0\",
    \"rootPath\": \"toolset/bin\",
    \"linker\": {
        \"path\": \"ld64.lld\"
    },
    \"librarian\": {
        \"path\": \"llvm-lib\"
    },
    \"swiftCompiler\": {
        \"extraCLIOptions\": [
            \"-Xfrontend\", \"-enable-cross-import-overlays\",
            \"-use-ld=lld\"
        ]
    }
}";
    op.fail_if_err_map(
        "write_metadata",
        fs::write(output_dir.join("toolset.json"), toolset),
        |e| format!("Failed to write toolset.json: {}", e),
    )?;

    // Same toolset, but for the SwiftBuild build system: it derives the linker
    // and librarian paths itself, so it must not be given extra compiler flags.
    // It needs Swift 6.4+ (6.3 has bugs resolving those paths) — this is the
    // toolset flavour xtool writes as `toolset-swb.json`.
    let toolset_swb = "{
    \"schemaVersion\": \"1.0\",
    \"rootPath\": \"toolset/bin\",
    \"linker\": {
        \"path\": \"ld64.lld\"
    },
    \"librarian\": {
        \"path\": \"llvm-lib\"
    }
}";
    op.fail_if_err_map(
        "write_metadata",
        fs::write(output_dir.join("toolset-swb.json"), toolset_swb),
        |e| format!("Failed to write toolset-swb.json: {}", e),
    )?;

    let sdk_def = SDKDefinition {
        schema_version: "4.0".to_string(),
        target_triples: HashMap::from([
            (
                "arm64-apple-ios".to_string(),
                Triple::from_sdk("iPhoneOS", &iphone_os_sdk),
            ),
            (
                "arm64-apple-ios-simulator".to_string(),
                Triple::from_sdk("iPhoneSimulator", &iphone_simulator_sdk),
            ),
            (
                "x86_64-apple-ios-simulator".to_string(),
                Triple::from_sdk("iPhoneSimulator", &iphone_simulator_sdk),
            ),
            (
                "arm64-apple-macos".to_string(),
                Triple::from_sdk("MacOSX", &mac_os_sdk),
            ),
            (
                "x86_64-apple-macos".to_string(),
                Triple::from_sdk("MacOSX", &mac_os_sdk),
            ),
        ]),
    };

    let sdk_def_path = output_dir.join("swift-sdk.json");
    op.fail_if_err_map(
        "write_metadata",
        fs::write(
            sdk_def_path,
            op.fail_if_err_map(
                "write_metadata",
                serde_json::to_string_pretty(&sdk_def),
                |e| format!("Failed to serialize SDKDefinition: {}", e),
            )?,
        ),
        |e| format!("Failed to write swift-sdk.json: {}", e),
    )?;

    let sdk_version_path = output_dir.join("darwin-sdk-version.txt");
    op.fail_if_err_map(
        "write_metadata",
        fs::write(&sdk_version_path, darwin_sdk_version()),
        |e| format!("Failed to write darwin-sdk-version.txt: {}", e),
    )?;
    op.move_on("write_metadata", "install_sdk")?;

    let real_output_dir =
        op.fail_if_err("install_sdk", linux_path(&output_dir.to_string_lossy()))?;
    let output = op.fail_if_err_map(
        "install_sdk",
        swift_bin.output(&["sdk", "install", &real_output_dir]),
        |e| format!("Failed to execute swift command: {}", e),
    )?;

    if !output.status.success() {
        return op.fail(
            "install_sdk",
            format!(
                "Swift command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        );
    }
    op.complete("install_sdk")?;

    Ok(())
}

fn sdk(dev: &PathBuf, platform: &str) -> Result<String, String> {
    let dir = dev.join(format!("Platforms/{}.platform/Developer/SDKs", platform));
    let regex = Regex::new(&format!(r"^{}\d+\.\d+\.sdk$", regex::escape(platform)))
        .map_err(|e| format!("Invalid regex: {}", e))?;

    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Failed to read SDKs directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if regex.is_match(&name_str) {
            return Ok(name_str.into_owned());
        }
    }

    Err(format!("Could not find SDK for {}/{}", platform, platform))
}

async fn install_toolset(output_path: &PathBuf) -> Result<(), String> {
    let toolset_dir = output_path.join("toolset");
    fs::create_dir_all(&toolset_dir)
        .map_err(|e| format!("Failed to create toolset directory: {}", e))?;

    let arch = toolset_arch()?;
    let toolset_url = format!(
        "https://github.com/xtool-org/darwin-tools-linux-llvm/releases/download/v{}/toolset-{}.tar.gz",
        DARWIN_TOOLS_VERSION, arch
    );

    let response = reqwest::get(&toolset_url)
        .await
        .map_err(|e| format!("Failed to download toolset: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Failed to download toolset: {}", response.status()));
    }
    let tar_gz = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(&*tar_gz));
    archive
        .unpack(&toolset_dir)
        .map_err(|e| format!("Failed to extract toolset: {}", e))?;

    postprocess_toolset(&toolset_dir)?;

    #[cfg(target_os = "windows")]
    {
        // I'm guessing this has to be done because I'm extracting the tar from windows into the wsl file system and windows doesn't play nice with permissions, but im too lazy to do this properly
        let wsl_toolset_path =
            windows_to_wsl_path(&toolset_dir.join("bin").to_string_lossy().to_string())?;
        let output = Command::new("wsl")
            .arg("chmod")
            .arg("+x")
            .arg(format!("{}/*", wsl_toolset_path))
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run chmod: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "Failed to set executable permissions: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        // the glob above does not cover bin/orig
        set_executable(
            &toolset_dir
                .join("bin/orig/ld64.lld")
                .to_string_lossy()
                .to_string(),
        )?;
    }

    // the trampoline is written by us, so it never gets a mode from the archive
    set_executable(&ld64_path(&toolset_dir).to_string_lossy().to_string())?;
    Ok(())
}

fn ld64_path(toolset_dir: &PathBuf) -> PathBuf {
    toolset_dir.join("bin").join("ld64.lld")
}

/// Turn a freshly extracted toolset into one that works with SwiftPM and with
/// the SwiftBuild system:
///   * expose the bundled llvm archive tool under the name SwiftBuild expects
///     (it assumes an Apple-flavored librarian on Apple platforms, but accepts
///     an explicit `llvm-lib`),
///   * replace `ld64.lld` with the `-r` trampoline (the real linker is kept as
///     `bin/orig/ld64.lld`).
fn postprocess_toolset(toolset_dir: &PathBuf) -> Result<(), String> {
    let bin = toolset_dir.join("bin");
    let libtool = bin.join("libtool");
    let llvm_lib = bin.join("llvm-lib");
    if libtool.exists() {
        fs::rename(&libtool, &llvm_lib)
            .map_err(|e| format!("Failed to rename toolset libtool: {}", e))?;
    } else if !llvm_lib.exists() {
        return Err("Toolset is missing bin/libtool".to_string());
    }

    let ld64 = ld64_path(toolset_dir);
    let orig_bins = bin.join("orig");
    let orig_ld64 = orig_bins.join("ld64.lld");
    fs::create_dir_all(&orig_bins)
        .map_err(|e| format!("Failed to create toolset bin/orig: {}", e))?;
    fs::rename(&ld64, &orig_ld64)
        .map_err(|e| format!("Failed to move toolset ld64.lld: {}", e))?;
    fs::write(&ld64, ld64_trampoline())
        .map_err(|e| format!("Failed to write ld64.lld trampoline: {}", e))?;
    Ok(())
}

/// Downloads and installs xtool's OpenAppleMacros server into the bundle root.
/// It is what Apple's `*Macros` modules resolve to on Linux: per-platform
/// symlinks created in `install_developer` hand it to swiftc as the plugin
/// server.
async fn install_macros(output_path: &PathBuf) -> Result<(), String> {
    let arch = toolset_arch()?;
    let url = format!(
        "https://github.com/xtool-org/OpenAppleMacros/releases/download/v{}/OpenAppleMacrosServer-{}",
        OPEN_APPLE_MACROS_VERSION, arch
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download OpenAppleMacros: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download OpenAppleMacros: {}",
            response.status()
        ));
    }
    let binary = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read OpenAppleMacros response: {}", e))?;

    let server_path = output_path.join("OpenAppleMacrosServer");
    fs::write(&server_path, &binary)
        .map_err(|e| format!("Failed to write OpenAppleMacrosServer: {}", e))?;
    set_executable(&server_path.to_string_lossy().to_string())?;
    Ok(())
}

async fn install_developer(
    app: AppHandle,
    output_path: &PathBuf,
    xcode_path: &str,
    is_dir: bool,
    op: &Operation<'_>,
) -> Result<PathBuf, String> {
    op.start("extract_xip")?;

    let dev_stage = output_path.join("DeveloperStage");
    let mut app_path = PathBuf::from(xcode_path);
    if !is_dir {
        op.fail_if_err_map("extract_xip", fs::create_dir_all(&dev_stage), |e| {
            format!("Failed to create DeveloperStage directory: {}", e)
        })?;

        let mut file = op.fail_if_err_map("extract_xip", fs::File::open(xcode_path), |e| {
            format!("Failed to open xip file: {}", e)
        })?;
        let cpio = op
            .fail_if_err_map(
                "extract_xip",
                app.path().resolve("cpio", BaseDirectory::Resource),
                |e| format!("Failed to resolve cpio path: {}", e),
            )?
            .to_string_lossy()
            .to_string();

        #[cfg(target_os = "windows")]
        let cpio = op.fail_if_err("extract_xip", windows_to_wsl_path(&cpio))?;

        op.fail_if_err_map("extract_xip", unxip(&mut file, &dev_stage, cpio), |e| {
            format!("Failed to extract xip file: {}", e)
        })?;

        let app_dirs = op
            .fail_if_err_map("extract_xip", fs::read_dir(&dev_stage), |e| {
                format!("Failed to read DeveloperStage directory: {}", e)
            })?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "app"))
            .collect::<Vec<_>>();
        if app_dirs.len() != 1 {
            return op.fail(
                "extract_xip",
                format!(
                    "Expected one .app in DeveloperStage, found {}",
                    app_dirs.len()
                ),
            );
        }

        app_path = app_dirs[0].path();
    }

    op.move_on("extract_xip", "copy_files")?;
    let dev = output_path.join("Developer");
    op.fail_if_err_map("copy_files", fs::create_dir_all(&dev), |e| {
        format!("Failed to create Developer directory: {}", e)
    })?;

    let contents_developer = app_path.join("Contents").join("Developer");
    if !contents_developer.exists() {
        return op.fail(
            "copy_files",
            "Contents/Developer not found in .app".to_string(),
        );
    }

    #[cfg(not(target_os = "windows"))]
    op.fail_if_err(
        "copy_files",
        copy_developer(
            &contents_developer,
            &dev,
            Path::new("Contents/Developer"),
            false,
        ),
    )?;

    #[cfg(target_os = "windows")]
    {
        let sdkmover_path = op
            .fail_if_err_map(
                "copy_files",
                app.path().resolve("sdkmoverbin", BaseDirectory::Resource),
                |e| format!("Failed to resolve sdkmoverbin path: {}", e),
            )?
            .to_string_lossy()
            .to_string();
        let linux_sdkmover_path =
            op.fail_if_err("copy_files", windows_to_wsl_path(&sdkmover_path))?;
        let linux_contents_developer = op.fail_if_err(
            "copy_files",
            windows_to_wsl_path(&contents_developer.to_string_lossy().to_string()),
        )?;
        let linux_dev = op.fail_if_err(
            "copy_files",
            windows_to_wsl_path(&dev.to_string_lossy().to_string()),
        )?;
        let output = op.fail_if_err_map(
            "copy_files",
            Command::new("wsl")
                .arg(&linux_sdkmover_path)
                .arg(&linux_contents_developer)
                .arg(&linux_dev)
                .creation_flags(CREATE_NO_WINDOW)
                .output(),
            |e| format!("Failed to run sdkmover: {}", e),
        )?;
        if !output.status.success() {
            return op.fail(
                "copy_files",
                format!(
                    "Failed to move files: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
            );
        }
    }

    if dev_stage.exists() {
        op.fail_if_err_map("copy_files", remove_dir_all(&dev_stage), |e| {
            format!("Failed to remove DeveloperStage directory: {}", e)
        })?;
    }

    for platform in ["iPhoneOS", "MacOSX", "iPhoneSimulator"] {
        let lib = "../../../../../Library";
        let dest = dev.join(format!(
            "Platforms/{}.platform/Developer/SDKs/{}.sdk/System/Library/Frameworks",
            platform, platform
        ));

        let links = [
            (
                "Testing.framework",
                format!("{}/Frameworks/Testing.framework", lib),
            ),
            (
                "XCTest.framework",
                format!("{}/Frameworks/XCTest.framework", lib),
            ),
            (
                "XCUIAutomation.framework",
                format!("{}/Frameworks/XCUIAutomation.framework", lib),
            ),
            (
                "XCTestCore.framework",
                format!("{}/PrivateFrameworks/XCTestCore.framework", lib),
            ),
        ];

        for (name, target) in &links {
            let link_path = dest.join(name);
            op.fail_if_err_map(
                "copy_files",
                symlink(target, &link_path.to_string_lossy().to_string()),
                |e| {
                    format!(
                        "Failed to create symlink {:?} -> {:?}: {}",
                        link_path, target, e
                    )
                },
            )?;
        }

        // Point the platform's plugin server at the OpenAppleMacros server we
        // installed in the bundle root, so Apple's macro modules resolve.
        let platform_dir = dev.join(format!("Platforms/{}.platform", platform));
        let plugin_bin = platform_dir.join("Developer/usr/bin");
        op.fail_if_err_map("copy_files", fs::create_dir_all(&plugin_bin), |e| {
            format!("Failed to create {:?}: {}", plugin_bin, e)
        })?;
        let plugin_server = plugin_bin.join("swift-plugin-server");
        if fs::symlink_metadata(&plugin_server).is_ok() {
            op.fail_if_err_map("copy_files", fs::remove_file(&plugin_server), |e| {
                format!("Failed to remove {:?}: {}", plugin_server, e)
            })?;
        }
        op.fail_if_err_map(
            "copy_files",
            symlink(
                "../../../../../../OpenAppleMacrosServer",
                &plugin_server.to_string_lossy().to_string(),
            ),
            |e| format!("Failed to create {:?}: {}", plugin_server, e),
        )?;

        let host_dir = platform_dir.join("Developer/usr/lib/swift/host");
        let plugins_dir = host_dir.join("plugins");
        if fs::symlink_metadata(&plugins_dir).is_ok() {
            let is_symlink = fs::symlink_metadata(&plugins_dir)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let removed = if is_symlink {
                fs::remove_file(&plugins_dir).map_err(|e| e.to_string())
            } else {
                remove_dir_all(&plugins_dir)
            };
            op.fail_if_err_map("copy_files", removed, |e| {
                format!("Failed to remove {:?}: {}", plugins_dir, e)
            })?;
        }

        if platform == "iPhoneSimulator" {
            // The simulator platform ships no plugins of its own, so mirror the
            // device ones.
            op.fail_if_err_map("copy_files", fs::create_dir_all(&host_dir), |e| {
                format!("Failed to create {:?}: {}", host_dir, e)
            })?;
            op.fail_if_err_map(
                "copy_files",
                symlink(
                    "../../../../../../iPhoneOS.platform/Developer/usr/lib/swift/host/plugins",
                    &plugins_dir.to_string_lossy().to_string(),
                ),
                |e| format!("Failed to create {:?}: {}", plugins_dir, e),
            )?;
        } else {
            // Empty stubs: they only need to exist so that swiftc believes the
            // modules are supported. The real implementations live in the
            // macro server.
            op.fail_if_err_map("copy_files", fs::create_dir_all(&plugins_dir), |e| {
                format!("Failed to create {:?}: {}", plugins_dir, e)
            })?;
            for library in OPEN_APPLE_MACROS_LIBRARIES {
                let stub = plugins_dir.join(format!("lib{}.so", library));
                op.fail_if_err_map("copy_files", fs::write(&stub, b""), |e| {
                    format!("Failed to create {:?}: {}", stub, e)
                })?;
            }
        }
    }

    op.complete("copy_files")?;

    Ok(dev)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Triple {
    sdk_root_path: String,
    include_search_paths: Vec<String>,
    library_search_paths: Vec<String>,
    swift_resources_path: String,
    swift_static_resources_path: String,
    toolset_paths: Vec<String>,
}

impl Triple {
    fn from_sdk(platform: &str, sdk: &str) -> Self {
        Triple {
            sdk_root_path: format!(
                "Developer/Platforms/{}.platform/Developer/SDKs/{}",
                platform, sdk
            ),
            include_search_paths: vec![format!(
                "Developer/Platforms/{}.platform/Developer/usr/lib",
                platform
            )],
            library_search_paths: vec![format!(
                "Developer/Platforms/{}.platform/Developer/usr/lib",
                platform
            )],
            swift_resources_path: format!(
                "Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift"
            ),
            swift_static_resources_path: format!(
                "Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift_static"
            ),
            toolset_paths: vec![format!("toolset.json")],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SDKDefinition {
    schema_version: String,
    target_triples: HashMap<String, Triple>,
}

pub fn unxip<R: Read + Seek + Sized + std::fmt::Debug>(
    reader: &mut R,
    output_path: &Path,
    cpio_path: String,
) -> Result<(), UnxipError> {
    let mut xip_reader = XipReader::new(reader)?;

    std::fs::create_dir_all(output_path).map_err(UnxipError::IoError)?;

    #[cfg(not(target_os = "windows"))]
    let mut child = Command::new(&cpio_path)
        .arg("-idm")
        .current_dir(output_path)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| UnxipError::Misc(format!("Failed to spawn cpio: {}", e)))?;

    #[cfg(target_os = "windows")]
    let mut child = Command::new("wsl")
        .arg(format!("{}", cpio_path))
        .arg("-idm")
        .current_dir(output_path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .spawn()
        .map_err(|e| UnxipError::Misc(format!("Failed to spawn cpio: {}", e)))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| UnxipError::Misc("Failed to open cpio stdin".to_string()))?;

        std::io::copy(&mut xip_reader, stdin).map_err(UnxipError::IoError)?;
    }

    let status = child.wait().map_err(UnxipError::IoError)?;
    if !status.success() {
        return Err(UnxipError::Misc(format!(
            "cpio failed with status: {}",
            status
        )));
    }
    Ok(())
}
