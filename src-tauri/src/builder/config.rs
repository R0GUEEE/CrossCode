use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::builder::swift::SwiftBin;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    CrosscodePackage,
    SwiftPackage,
    XcodeWorkspace,
    XcodeProject,
    CocoaPods,
    Tuist,
    XcodeGen,
    Make,
    Bazel,
    CMake,
    Fastlane,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub kind: ProjectKind,
    pub root: String,
    pub build_root: String,
    pub entry_point: Option<String>,
    pub capabilities: Vec<String>,
    pub targets: Vec<String>,
    pub schemes: Vec<String>,
    pub configurations: Vec<String>,
    pub build_type: String,
    pub detected_files: Vec<String>,
}

impl ProjectInfo {
    pub fn detect(root: PathBuf) -> Result<Self, String> {
        if !root.is_dir() {
            return Err(format!("Project path is not a directory: {}", root.display()));
        }

        let mut entries = std::fs::read_dir(&root)
            .map_err(|e| format!("Failed to read project directory: {}", e))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());

        let has = |name: &str| root.join(name).exists();
        let find_extension = |extension: &str| {
            entries.iter().find_map(|entry| {
                let path = entry.path();
                (path.extension().and_then(|value| value.to_str()) == Some(extension))
                    .then(|| path)
            })
        };

        let find_named = |name: &str| {
            let direct = root.join(name);
            if direct.exists() {
                return Some(direct);
            }
            find_files(&root, 2, &|path| path.file_name().and_then(|value| value.to_str()) == Some(name))
                .into_iter()
                .next()
        };
        let find_nested_extension = |extension: &str| {
            find_files(&root, 2, &|path| {
                path.extension().and_then(|value| value.to_str()) == Some(extension)
            })
            .into_iter()
            .next()
        };

        let (kind, entry_point) = if let Some(path) = find_extension("xcworkspace") {
            (ProjectKind::XcodeWorkspace, Some(path))
        } else if let Some(path) = find_nested_extension("xcworkspace") {
            (ProjectKind::XcodeWorkspace, Some(path))
        } else if let Some(path) = find_extension("xcodeproj") {
            (ProjectKind::XcodeProject, Some(path))
        } else if let Some(path) = find_nested_extension("xcodeproj") {
            (ProjectKind::XcodeProject, Some(path))
        } else if has("Package.swift") && has("crosscode.toml") {
            (ProjectKind::CrosscodePackage, Some(root.join("Package.swift")))
        } else if let Some(path) = find_named("Package.swift") {
            (ProjectKind::SwiftPackage, Some(path))
        } else if let Some(path) = find_named("Podfile") {
            (ProjectKind::CocoaPods, Some(path))
        } else if has("Project.swift") || has("Tuist.swift") || has("ProjectDescriptionHelpers") {
            (ProjectKind::Tuist, find_extension("swift"))
        } else if has("project.yml") || has("project.yaml") {
            (ProjectKind::XcodeGen, Some(if has("project.yml") { root.join("project.yml") } else { root.join("project.yaml") }))
        } else if has("Makefile") || has("makefile") {
            (ProjectKind::Make, Some(if has("Makefile") { root.join("Makefile") } else { root.join("makefile") }))
        } else if has("WORKSPACE") || has("BUILD") || has("MODULE.bazel") {
            (ProjectKind::Bazel, find_extension("bazel"))
        } else if has("CMakeLists.txt") {
            (ProjectKind::CMake, Some(root.join("CMakeLists.txt")))
        } else if has("Fastfile") || has("fastlane") {
            (ProjectKind::Fastlane, find_named("Fastfile"))
        } else {
            (ProjectKind::Unknown, None)
        };

        let (targets, schemes) = discover_targets_and_schemes(&root, entry_point.as_ref(), &kind);
        let detected_files = detected_files(&root, &kind, entry_point.as_ref());
        let build_root = project_build_root(&root, &kind, entry_point.as_ref());

        let mut capabilities = vec!["edit".to_string(), "sourceKitLsp".to_string()];
        if matches!(kind, ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace) {
            capabilities.push("xcodeBuild".to_string());
            capabilities.push("simulator".to_string());
            capabilities.push("archive".to_string());
        }
        if matches!(kind, ProjectKind::SwiftPackage | ProjectKind::CrosscodePackage | ProjectKind::Tuist | ProjectKind::Make | ProjectKind::Bazel | ProjectKind::CMake) {
            capabilities.push("swiftBuild".to_string());
        }
        if matches!(kind, ProjectKind::Tuist | ProjectKind::XcodeGen) {
            capabilities.push("generate".to_string());
        }
        if matches!(kind, ProjectKind::CocoaPods) {
            capabilities.push("cocoapods".to_string());
        }
        if matches!(kind, ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace) {
            capabilities.push("remoteBuild".to_string());
        }
        if matches!(kind, ProjectKind::SwiftPackage | ProjectKind::CrosscodePackage | ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace | ProjectKind::Tuist | ProjectKind::XcodeGen | ProjectKind::Make | ProjectKind::Bazel) {
            capabilities.push("test".to_string());
        }

        Ok(ProjectInfo {
            kind,
            root: root.to_string_lossy().to_string(),
            build_root: build_root.to_string_lossy().to_string(),
            entry_point: entry_point.map(|path| path.to_string_lossy().to_string()),
            capabilities,
            targets,
            schemes,
            configurations: vec!["Debug".to_string(), "Release".to_string()],
            build_type: project_kind_label(&kind).to_string(),
            detected_files,
        })
    }
}

fn discover_targets_and_schemes(
    root: &PathBuf,
    entry_point: Option<&PathBuf>,
    kind: &ProjectKind,
) -> (Vec<String>, Vec<String>) {
    let mut targets = Vec::new();
    let mut schemes = Vec::new();
    if matches!(kind, ProjectKind::SwiftPackage | ProjectKind::CrosscodePackage) {
        if let Ok(contents) = std::fs::read_to_string(root.join("Package.swift")) {
            for marker in ["target(name:", "executableTarget(name:", "testTarget(name:"] {
                let mut rest = contents.as_str();
                while let Some(index) = rest.find(marker) {
                    rest = &rest[index + marker.len()..];
                    if let Some(start) = rest.find('"') {
                        let value = &rest[start + 1..];
                        if let Some(end) = value.find('"') {
                            let name = value[..end].to_string();
                            if !targets.contains(&name) { targets.push(name); }
                        }
                    }
                }
            }
        }
    }
    if matches!(kind, ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace) {
        if let Some(entry) = entry_point {
            let project_root = if entry.extension().and_then(|value| value.to_str()) == Some("xcodeproj") {
                entry.join("project.pbxproj")
            } else {
                find_files(root, 3, &|path| path.file_name().and_then(|value| value.to_str()) == Some("project.pbxproj"))
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| root.join("project.pbxproj"))
            };
            if let Ok(contents) = std::fs::read_to_string(project_root) {
                for line in contents.lines() {
                    if line.contains("name =") && line.contains("; /*") {
                        let name = line.split("name =").nth(1).unwrap_or("").split(';').next().unwrap_or("").trim().trim_matches('"');
                        if !name.is_empty() && !targets.contains(&name.to_string()) { targets.push(name.to_string()); }
                    }
                }
            }
        }
        for scheme_path in find_files(root, 4, &|path| {
            path.extension().and_then(|value| value.to_str()) == Some("xcscheme")
                && path.components().any(|component| component.as_os_str().to_str() == Some("xcshareddata"))
        }) {
            if let Some(name) = scheme_path.file_stem().and_then(|value| value.to_str()) {
                schemes.push(name.to_string());
            }
        }
    }
    targets.sort();
    schemes.sort();
    (targets, schemes)
}

fn find_files(root: &PathBuf, max_depth: usize, predicate: &dyn Fn(&PathBuf) -> bool) -> Vec<PathBuf> {
    if max_depth == 0 {
        return Vec::new();
    }
    let mut matches = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return matches };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if path.is_dir() {
            if matches!(name, ".git" | ".build" | "node_modules" | "target" | ".crosscode") {
                continue;
            }
            matches.extend(find_files(&path, max_depth - 1, predicate));
        } else if predicate(&path) {
            matches.push(path);
        }
    }
    matches.sort();
    matches
}

fn detected_files(root: &PathBuf, kind: &ProjectKind, entry_point: Option<&PathBuf>) -> Vec<String> {
    let mut files = entry_point
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let marker = match kind {
        ProjectKind::CrosscodePackage => Some("crosscode.toml"),
        ProjectKind::CocoaPods => Some("Podfile.lock"),
        ProjectKind::Tuist => Some("Project.swift"),
        ProjectKind::Bazel => Some("MODULE.bazel"),
        ProjectKind::CMake => Some("CMakeLists.txt"),
        ProjectKind::Fastlane => Some("Fastfile"),
        _ => None,
    };
    if let Some(marker) = marker {
        let path = root.join(marker);
        if path.exists() {
            files.push(path.to_string_lossy().to_string());
        }
    }
    files.sort();
    files.dedup();
    files
}

fn project_kind_label(kind: &ProjectKind) -> &'static str {
    match kind {
        ProjectKind::CrosscodePackage => "CrossCode Package",
        ProjectKind::SwiftPackage => "Swift Package Manager",
        ProjectKind::XcodeWorkspace => "Xcode Workspace",
        ProjectKind::XcodeProject => "Xcode Project",
        ProjectKind::CocoaPods => "CocoaPods",
        ProjectKind::Tuist => "Tuist",
        ProjectKind::XcodeGen => "XcodeGen",
        ProjectKind::Make => "Make",
        ProjectKind::Bazel => "Bazel",
        ProjectKind::CMake => "CMake",
        ProjectKind::Fastlane => "Fastlane",
        ProjectKind::Unknown => "Unknown",
    }
}

fn project_build_root(root: &PathBuf, kind: &ProjectKind, entry_point: Option<&PathBuf>) -> PathBuf {
    if matches!(kind, ProjectKind::SwiftPackage | ProjectKind::CocoaPods | ProjectKind::Make | ProjectKind::Bazel | ProjectKind::CMake | ProjectKind::Fastlane) {
        if let Some(entry) = entry_point {
            if let Some(parent) = entry.parent() {
                return parent.to_path_buf();
            }
        }
    }
    root.clone()
}

pub struct BuildSettings {
    pub debug: bool,
}

// TODO: Min ios version, etc.
pub struct ProjectConfig {
    pub product: String,
    pub version_num: String,
    pub version_string: String,
    pub bundle_id: String,
    pub project_path: PathBuf,
}

#[derive(Deserialize, Serialize)]
pub struct TomlConfig {
    pub format_version: u32,
    pub project: ProjectTomlConfig,
}

#[derive(Deserialize, Serialize)]
pub struct ProjectTomlConfig {
    pub version_num: String,
    pub version_string: String,
    pub bundle_id: String,
}

// TODO: Check platforms
#[derive(Deserialize)]
struct SwiftPackageDump {
    name: String,
    targets: Vec<SwiftPackageTarget>,
}

// TODO: Resources
#[derive(Deserialize)]
struct SwiftPackageTarget {
    name: String,
}

#[derive(Deserialize, Serialize)]
pub enum ProjectValidation {
    Valid,
    Invalid,
    UnsupportedFormatVersion,
    InvalidPackage,
    InvalidToolchain,
}

impl ProjectConfig {
    pub fn load(project_path: PathBuf, toolchain_path: &str) -> Result<Self, String> {
        let toml_config = TomlConfig::load_or_default(project_path.clone())?;
        let swift = SwiftBin::new(toolchain_path)?;
        let raw_package = swift
            .command()
            .arg("package")
            .arg("dump-package")
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to execute swift command: {}", e))?;
        if !raw_package.status.success() {
            return Err(format!(
                "Failed to dump package: {}",
                String::from_utf8_lossy(&raw_package.stderr)
            ));
        }

        let package: SwiftPackageDump = serde_json::from_slice(&raw_package.stdout)
            .map_err(|e| format!("Failed to parse package dump: {}", e))?;

        Ok(ProjectConfig {
            product: package.name,
            version_num: toml_config.project.version_num,
            version_string: toml_config.project.version_string,
            bundle_id: toml_config.project.bundle_id,
            project_path,
        })
    }

    pub fn validate(project_path: PathBuf, toolchain_path: &str) -> ProjectValidation {
        if !project_path.exists() {
            return ProjectValidation::Invalid;
        }
        if !project_path.join("Package.swift").exists() {
            return ProjectValidation::Invalid;
        }
        if !project_path.join("crosscode.toml").exists() {
            return ProjectValidation::Invalid;
        }
        let config_res = TomlConfig::load(project_path.clone());
        // make sure the error isn't unsupported format version
        if let Err(e) = config_res {
            if e.contains("Unsupported format version") {
                return ProjectValidation::UnsupportedFormatVersion;
            }
        }

        let swift = SwiftBin::new(toolchain_path);
        if let Err(_) = swift {
            return ProjectValidation::InvalidToolchain;
        }
        let swift = swift.unwrap();

        let raw_package = swift
            .command()
            .arg("package")
            .arg("dump-package")
            .current_dir(&project_path)
            .output();
        if let Err(_) = raw_package {
            return ProjectValidation::InvalidToolchain;
        }
        let raw_package = raw_package.unwrap();

        if !raw_package.status.success() {
            return ProjectValidation::InvalidPackage;
        }

        let package = serde_json::from_slice::<SwiftPackageDump>(&raw_package.stdout);
        if let Err(_) = package {
            return ProjectValidation::InvalidPackage;
        }

        ProjectValidation::Valid
    }
}

impl TomlConfig {
    pub fn default(bundle_id: &str) -> Self {
        TomlConfig {
            format_version: FORMAT_VERSION,
            project: ProjectTomlConfig {
                version_num: "1".to_string(),
                version_string: "1.0.0".to_string(),
                bundle_id: bundle_id.to_string(),
            },
        }
    }

    pub fn load_or_default(project_path: PathBuf) -> Result<Self, String> {
        if project_path.exists() {
            Self::load(project_path)
        } else {
            let config = Self::default("com.example.myapp");
            config.save(project_path)?;
            Ok(config)
        }
    }

    fn load(project_path: PathBuf) -> Result<Self, String> {
        let content = std::fs::read_to_string(project_path.join("crosscode.toml"))
            .map_err(|e| e.to_string())?;
        let config: TomlConfig = toml::from_str(&content).map_err(|e| e.to_string())?;
        if config.format_version != FORMAT_VERSION {
            return Err(format!(
                "Unsupported format version: {}, expected: {}",
                config.format_version, FORMAT_VERSION
            ));
        }
        Ok(config)
    }

    pub fn save(&self, project_path: PathBuf) -> Result<(), String> {
        let content = toml::to_string(self).map_err(|e| e.to_string())?;
        std::fs::write(project_path.join("crosscode.toml"), content).map_err(|e| e.to_string())?;
        Ok(())
    }
}
