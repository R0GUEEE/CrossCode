// Support code for importing Xcode projects and for browsing the Swift
// packages of a workspace.
//
// The interesting part of the import (parsing `project.pbxproj` and building
// the plan) lives in the frontend: this module only applies the resulting plan
// to disk and lists SwiftPM packages/targets.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::builder::swift::SwiftBin;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    /// Package relative path, using "/" separators.
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCopy {
    /// Absolute source path.
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub package_dir: String,
    pub written: Vec<String>,
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
}

/// Configuration files CrossCode owns: they are only written when the caller
/// explicitly allows replacing them.
const CONFIG_FILES: [&str; 2] = ["Package.swift", "crosscode.toml"];

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty() && *part != ".") {
        path.push(part);
    }
    path
}

fn write_parents(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    Ok(())
}

/// Writes the files of an import plan and copies the resources it references.
#[tauri::command]
pub fn apply_xcode_import(
    package_root: String,
    files: Vec<ImportFile>,
    copies: Vec<ImportCopy>,
    overwrite: bool,
) -> Result<ImportReport, String> {
    if package_root.trim().is_empty() {
        return Err("No destination folder was selected".to_string());
    }
    let package_dir = PathBuf::from(&package_root);
    fs::create_dir_all(&package_dir)
        .map_err(|e| format!("Failed to create {}: {}", package_dir.display(), e))?;

    if !overwrite {
        let conflicts: Vec<String> = CONFIG_FILES
            .iter()
            .filter(|name| package_dir.join(*name).exists())
            .map(|name| name.to_string())
            .collect();
        if !conflicts.is_empty() {
            return Err(format!(
                "{} already exist in {}. Enable \"overwrite\" to replace them.",
                conflicts.join(" and "),
                package_dir.display()
            ));
        }
    }

    let mut written = Vec::new();
    let mut skipped = Vec::new();

    for file in &files {
        let target = join_relative(&package_dir, &file.path);
        let is_config = CONFIG_FILES.iter().any(|name| *name == file.path);
        if target.exists() && !is_config {
            // e.g. an Info.plist the project already has: keep the user's file
            skipped.push(format!("{} (already exists)", file.path));
            continue;
        }
        write_parents(&target)?;
        fs::write(&target, &file.contents)
            .map_err(|e| format!("Failed to write {}: {}", target.display(), e))?;
        written.push(file.path.clone());
    }

    let mut copied = Vec::new();
    for copy in &copies {
        let source = PathBuf::from(&copy.from);
        if !source.is_file() {
            skipped.push(format!("{} (not found)", copy.from));
            continue;
        }
        let target = join_relative(&package_dir, &copy.to);
        write_parents(&target)?;
        fs::copy(&source, &target).map_err(|e| {
            format!(
                "Failed to copy {} to {}: {}",
                source.display(),
                target.display(),
                e
            )
        })?;
        copied.push(copy.to.clone());
    }

    Ok(ImportReport {
        package_dir: package_dir.to_string_lossy().to_string(),
        written,
        copied,
        skipped,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageTargetInfo {
    pub name: String,
    /// "regular", "executable", "test", ...
    pub kind: String,
    /// Package relative directory the target's sources live in.
    pub path: String,
    pub is_test: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub path: String,
    pub targets: Vec<PackageTargetInfo>,
    pub error: Option<String>,
}

/// SwiftPM's default source directories, used when a target does not declare a
/// custom `path`.
fn default_target_path(name: &str, kind: &str) -> String {
    if kind == "test" {
        format!("Tests/{}", name)
    } else {
        format!("Sources/{}", name)
    }
}

fn dump_package(swift: &SwiftBin, package_dir: &Path) -> Result<Vec<PackageTargetInfo>, String> {
    let output = swift
        .command()
        .arg("package")
        .arg("dump-package")
        .current_dir(package_dir)
        .output()
        .map_err(|e| format!("Failed to run swift: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let manifest: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse the package manifest: {}", e))?;
    let mut targets = Vec::new();
    if let Some(list) = manifest.get("targets").and_then(|value| value.as_array()) {
        for target in list {
            let name = target
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                continue;
            }
            let kind = target
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("regular")
                .to_string();
            let path = target
                .get("path")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| default_target_path(&name, &kind));
            let is_test = kind == "test";
            targets.push(PackageTargetInfo {
                name,
                kind,
                path,
                is_test,
            });
        }
    }
    Ok(targets)
}

fn is_hidden(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        let name = name.as_ref();
        name == ".build"
            || name == ".git"
            || name == ".crosscode"
            || name == "node_modules"
            || name == "DerivedData"
    })
}

/// Finds the SwiftPM packages below `root_path` and reports their targets, so
/// the UI builder can write into the package and target the user selects.
#[tauri::command]
pub fn list_swift_packages(
    root_path: String,
    toolchain_path: String,
) -> Result<Vec<PackageInfo>, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let swift = SwiftBin::new(&toolchain_path)?;

    let mut directories: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_hidden(entry.path()))
        .filter_map(|entry| entry.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == "Package.swift" {
            if let Some(parent) = entry.path().parent() {
                directories.push(parent.to_path_buf());
            }
        }
        if directories.len() >= 20 {
            break;
        }
    }
    directories.sort();
    directories.dedup();

    let mut packages = Vec::new();
    for directory in directories {
        let name = directory
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let (targets, error) = match dump_package(&swift, &directory) {
            Ok(targets) => (targets, None),
            Err(message) => (Vec::new(), Some(message)),
        };
        packages.push(PackageInfo {
            name,
            path: directory.to_string_lossy().to_string(),
            targets,
            error,
        });
    }

    Ok(packages)
}
