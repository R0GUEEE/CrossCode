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
    Make,
    Bazel,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub kind: ProjectKind,
    pub root: String,
    pub entry_point: Option<String>,
    pub capabilities: Vec<String>,
    pub targets: Vec<String>,
    pub schemes: Vec<String>,
    pub configurations: Vec<String>,
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

        let (kind, entry_point) = if let Some(path) = find_extension("xcworkspace") {
            (ProjectKind::XcodeWorkspace, Some(path))
        } else if let Some(path) = find_extension("xcodeproj") {
            (ProjectKind::XcodeProject, Some(path))
        } else if has("Package.swift") && has("crosscode.toml") {
            (ProjectKind::CrosscodePackage, Some(root.join("Package.swift")))
        } else if has("Package.swift") {
            (ProjectKind::SwiftPackage, Some(root.join("Package.swift")))
        } else if has("Podfile") {
            (ProjectKind::CocoaPods, Some(root.join("Podfile")))
        } else if has("Project.swift") || has("Tuist.swift") || has("ProjectDescriptionHelpers") {
            (ProjectKind::Tuist, find_extension("swift"))
        } else if has("Makefile") || has("makefile") {
            (ProjectKind::Make, Some(if has("Makefile") { root.join("Makefile") } else { root.join("makefile") }))
        } else if has("WORKSPACE") || has("BUILD") || has("MODULE.bazel") {
            (ProjectKind::Bazel, find_extension("bazel"))
        } else {
            (ProjectKind::Unknown, None)
        };

        let (targets, schemes) = discover_targets_and_schemes(&root, entry_point.as_ref(), &kind);

        let mut capabilities = vec!["edit".to_string(), "sourceKitLsp".to_string()];
        if matches!(kind, ProjectKind::XcodeProject | ProjectKind::XcodeWorkspace) {
            capabilities.push("xcodeBuild".to_string());
            capabilities.push("simulator".to_string());
        }
        if matches!(kind, ProjectKind::SwiftPackage | ProjectKind::CrosscodePackage | ProjectKind::Tuist | ProjectKind::Make | ProjectKind::Bazel) {
            capabilities.push("swiftBuild".to_string());
        }
        if matches!(kind, ProjectKind::CocoaPods) {
            capabilities.push("cocoapods".to_string());
        }

        Ok(ProjectInfo {
            kind,
            root: root.to_string_lossy().to_string(),
            entry_point: entry_point.map(|path| path.to_string_lossy().to_string()),
            capabilities,
            targets,
            schemes,
            configurations: vec!["Debug".to_string(), "Release".to_string()],
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
                root.join("project.pbxproj")
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
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let schemes_dir = entry.path().join("xcshareddata").join("xcschemes");
                if let Ok(scheme_entries) = std::fs::read_dir(schemes_dir) {
                    for scheme in scheme_entries.flatten() {
                        if scheme.path().extension().and_then(|value| value.to_str()) == Some("xcscheme") {
                            if let Some(name) = scheme.path().file_stem().and_then(|value| value.to_str()) { schemes.push(name.to_string()); }
                        }
                    }
                }
            }
        }
    }
    targets.sort();
    schemes.sort();
    (targets, schemes)
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
