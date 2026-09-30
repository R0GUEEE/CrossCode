use std::{path::PathBuf, process::Command};

use sysinfo::System;
use tauri::Emitter;

use crate::builder::{
    config::{ProjectConfig, ProjectInfo, ProjectKind, ProjectValidation},
    remote::{remote_project_command, shell_quote, RemoteAction, RemoteMacProfile},
    swift::{pipe_command, SwiftBin},
};

#[tauri::command]
pub fn has_limited_ram() -> bool {
    let s = System::new_all();
    let mem_gib = s.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    // This is intended to be 16gb, however 16gb of physical ram does not always translate to 16gb of usable memory.
    mem_gib < 14.0
}

#[tauri::command]
pub fn validate_project(project_path: String, toolchain_path: String) -> ProjectValidation {
    ProjectConfig::validate(PathBuf::from(project_path), &toolchain_path)
}

#[tauri::command]
pub fn detect_project(project_path: String) -> Result<ProjectInfo, String> {
    ProjectInfo::detect(PathBuf::from(project_path))
}

#[tauri::command]
pub async fn build_project(
    window: tauri::Window,
    project_path: String,
    toolchain_path: String,
    target: String,
    scheme: String,
    configuration: String,
    remote_mac: Option<RemoteMacProfile>,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    let info = ProjectInfo::detect(root.clone())?;
    let build_root = PathBuf::from(&info.build_root);

    if let Some(profile) = remote_mac.as_ref().filter(|profile| profile.enabled) {
        let mut xcodebuild = RemoteMacProfile::xcodebuild_command(
            &info,
            RemoteAction::Build,
            &target,
            &scheme,
            &configuration,
        )?;
        append_remote_options(profile, &mut xcodebuild);
        window
            .emit(
                "build-output",
                format!("Building on remote Mac {}@{}...", profile.user, profile.host),
            )
            .map_err(|error| error.to_string())?;
        return run_remote(&window, profile, &xcodebuild).await;
    }

    let mut command = match info.kind {
        ProjectKind::CrosscodePackage | ProjectKind::SwiftPackage => {
            let swift = SwiftBin::new(&toolchain_path)?;
            let mut command = swift.command();
            command.arg("build");
            if !target.trim().is_empty() {
                command.arg("--target").arg(&target);
            }
            if configuration.eq_ignore_ascii_case("release") {
                command.arg("-c").arg("release");
            }
            command.current_dir(&build_root);
            command
        }
        ProjectKind::XcodeProject => {
            let entry = info.entry_point.ok_or("Xcode project entry point is missing")?;
            let mut command = Command::new("xcodebuild");
            command.arg("-project").arg(&entry);
            append_xcode_selection(&mut command, &target, &scheme, &configuration);
            command.arg("build").current_dir(&build_root);
            command
        }
        ProjectKind::XcodeWorkspace => {
            let entry = info.entry_point.ok_or("Xcode workspace entry point is missing")?;
            let mut command = Command::new("xcodebuild");
            command.arg("-workspace").arg(&entry);
            append_xcode_selection(&mut command, &target, &scheme, &configuration);
            command.arg("build").current_dir(root);
            command
        }
        ProjectKind::CocoaPods => {
            let mut command = Command::new("pod");
            command.args(["install"]).current_dir(&build_root);
            command
        }
        ProjectKind::Tuist => {
            let mut command = Command::new("tuist");
            command.args(["generate", "--no-open"]).current_dir(&build_root);
            command
        }
        ProjectKind::XcodeGen => {
            let mut command = Command::new("xcodegen");
            command.args(["generate"]).current_dir(&build_root);
            command
        }
        ProjectKind::Make => {
            let mut command = Command::new("make");
            command.current_dir(&build_root);
            command
        }
        ProjectKind::Bazel => {
            let mut command = Command::new("bazel");
            command.args(["build", "//..."]).current_dir(&build_root);
            command
        }
        ProjectKind::CMake => {
            let mut command = Command::new("cmake");
            command.args(["--build", "build"]).current_dir(&build_root);
            command
        }
        ProjectKind::Fastlane => {
            let mut command = Command::new("fastlane");
            command.args(["build"]).current_dir(&build_root);
            command
        }
        ProjectKind::Unknown => {
            return Err("Crosscode could not identify a supported project build system".to_string())
        }
    };

    window
        .emit("build-output", format!("Building {:?} project...", info.kind))
        .map_err(|error| error.to_string())?;
    pipe_command(&mut command, &window, true).await
}

#[tauri::command]
pub async fn test_project(
    window: tauri::Window,
    project_path: String,
    toolchain_path: String,
    target: String,
    scheme: String,
    configuration: String,
    remote_mac: Option<RemoteMacProfile>,
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    let info = ProjectInfo::detect(root.clone())?;
    let build_root = PathBuf::from(&info.build_root);

    if matches!(info.kind, ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace)
        && scheme.trim().is_empty()
    {
        return Err("Select a shared Xcode scheme before running tests".to_string());
    }

    if let Some(profile) = remote_mac.as_ref().filter(|profile| profile.enabled) {
        let mut xcodebuild = RemoteMacProfile::xcodebuild_command(
            &info,
            RemoteAction::Test,
            &target,
            &scheme,
            &configuration,
        )?;
        append_remote_options(profile, &mut xcodebuild);
        window
            .emit(
                "build-output",
                format!("Testing on remote Mac {}@{}...", profile.user, profile.host),
            )
            .map_err(|error| error.to_string())?;
        return run_remote(&window, profile, &xcodebuild).await;
    }

    let mut command = match info.kind {
        ProjectKind::CrosscodePackage | ProjectKind::SwiftPackage => {
            let swift = SwiftBin::new(&toolchain_path)?;
            let mut command = swift.command();
            command.arg("test");
            if configuration.eq_ignore_ascii_case("release") {
                command.arg("-c").arg("release");
            }
            command.current_dir(&build_root);
            command
        }
        ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace => {
            let entry = info.entry_point.ok_or("Xcode project entry point is missing")?;
            let mut command = Command::new("xcodebuild");
            if matches!(info.kind, ProjectKind::XcodeProject) {
                command.arg("-project");
            } else {
                command.arg("-workspace");
            }
            command.arg(entry);
            append_xcode_selection(&mut command, &target, &scheme, &configuration);
            command.arg("test").current_dir(&build_root);
            command
        }
        ProjectKind::Tuist => {
            let mut command = Command::new("tuist");
            command.arg("test");
            if !scheme.trim().is_empty() {
                command.arg(&scheme);
            }
            command.current_dir(&build_root);
            command
        }
        ProjectKind::XcodeGen => {
            return Err("XcodeGen tests require a generated Xcode project and scheme".to_string())
        }
        ProjectKind::Make => {
            let mut command = Command::new("make");
            command.arg("test").current_dir(&build_root);
            command
        }
        ProjectKind::Bazel => {
            let mut command = Command::new("bazel");
            command.args(["test", "//..."]).current_dir(&build_root);
            command
        }
        ProjectKind::CMake => {
            let mut command = Command::new("ctest");
            command.args(["--test-dir", "build"]).current_dir(&build_root);
            command
        }
        ProjectKind::Fastlane => {
            let mut command = Command::new("fastlane");
            command.args(["test"]).current_dir(&build_root);
            command
        }
        ProjectKind::CocoaPods => {
            return Err("CocoaPods itself has no test command. Open its generated Xcode workspace to run tests.".to_string())
        }
        ProjectKind::Unknown => return Err("Crosscode could not identify a supported test system".to_string()),
    };

    window
        .emit("build-output", format!("Testing {:?} project...", info.kind))
        .map_err(|error| error.to_string())?;
    pipe_command(&mut command, &window, true).await
}

fn append_xcode_selection(command: &mut Command, target: &str, scheme: &str, configuration: &str) {
    if !scheme.trim().is_empty() {
        command.arg("-scheme").arg(scheme);
    } else if !target.trim().is_empty() {
        command.arg("-target").arg(target);
    }
    if !configuration.trim().is_empty() {
        command.arg("-configuration").arg(configuration);
    }
}


#[tauri::command]
pub async fn test_remote_mac(window: tauri::Window, remote_mac: RemoteMacProfile) -> Result<(), String> {
    window
        .emit(
            "build-output",
            format!(
                "Testing remote Mac {}@{}...",
                remote_mac.user, remote_mac.host
            ),
        )
        .map_err(|error| error.to_string())?;
    crate::builder::remote::test_connection(&window, &remote_mac).await
}

/// Adds the destination and result bundle flags a profile may carry.
fn append_remote_options(profile: &RemoteMacProfile, command: &mut String) {
    if let Some(destination) = profile.destination.as_deref() {
        if !destination.trim().is_empty() {
            command.push_str(&format!(" -destination {}", shell_quote(destination.trim())));
        }
    }
    if let Some(bundle) = profile.result_bundle_path.as_deref() {
        if !bundle.trim().is_empty() {
            command.push_str(&format!(" -resultBundlePath {}", shell_quote(bundle.trim())));
        }
    }
}

/// Runs a prepared `xcodebuild` invocation in the remote project directory.
async fn run_remote(
    window: &tauri::Window,
    profile: &RemoteMacProfile,
    xcodebuild: &str,
) -> Result<(), String> {
    profile.validate()?;
    profile.validate_identity_file()?;
    let mut command = profile.ssh_command();
    command.arg(remote_project_command(profile, xcodebuild));
    pipe_command(&mut command, window, true).await
}

// #[tauri::command]
// pub fn ensure_lsp_config(project_path: String) -> Result<(), String> {
//     let project_path = PathBuf::from(project_path);
//     if !project_path.exists() {
//         return Err(format!("Project path does not exist: {:?}", project_path));
//     }

//     let sourcekit_lsp_path = project_path.join(".sourcekit-lsp");
//     if !sourcekit_lsp_path.exists() {
//         fs::create_dir_all(sourcekit_lsp_path).map_err(|e| e.to_string())?;
//     }

//     let config_path = project_path.join(".sourcekit-lsp").join("config.json");
//     if !config_path.exists() {
//         fs::write(config_path, "{
//   \"$schema\": \"https://raw.githubusercontent.com/swiftlang/sourcekit-lsp/refs/heads/release/6.4/config.schema.json\",
//   \"swiftPM\": {
//     \"swiftSDK\": \"arm64-apple-ios\"
//   }
// }").map_err(|e| e.to_string())?;
//     }
//     Ok(())
// }
