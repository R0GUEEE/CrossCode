use std::{path::PathBuf, process::Command};

use sysinfo::System;
use tauri::Emitter;

use crate::builder::{
    config::{ProjectConfig, ProjectInfo, ProjectKind, ProjectValidation},
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
) -> Result<(), String> {
    let root = PathBuf::from(&project_path);
    let info = ProjectInfo::detect(root.clone())?;

    let mut command = match info.kind {
        ProjectKind::CrosscodePackage | ProjectKind::SwiftPackage => {
            let swift = SwiftBin::new(&toolchain_path)?;
            let mut command = swift.command();
            command.arg("build").current_dir(root);
            command
        }
        ProjectKind::XcodeProject => {
            let entry = info.entry_point.ok_or("Xcode project entry point is missing")?;
            let mut command = Command::new("xcodebuild");
            command.arg("-project").arg(&entry).arg("build").current_dir(root);
            command
        }
        ProjectKind::XcodeWorkspace => {
            let entry = info.entry_point.ok_or("Xcode workspace entry point is missing")?;
            let mut command = Command::new("xcodebuild");
            command.arg("-workspace").arg(&entry).arg("build").current_dir(root);
            command
        }
        ProjectKind::CocoaPods => {
            let mut command = Command::new("pod");
            command.args(["install"]).current_dir(root);
            command
        }
        ProjectKind::Tuist => {
            let mut command = Command::new("tuist");
            command.args(["generate", "--no-open"]).current_dir(root);
            command
        }
        ProjectKind::Make => {
            let mut command = Command::new("make");
            command.current_dir(root);
            command
        }
        ProjectKind::Bazel => {
            let mut command = Command::new("bazel");
            command.args(["build", "//..."]).current_dir(root);
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
