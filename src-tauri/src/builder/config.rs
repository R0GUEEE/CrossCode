use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::builder::swift::SwiftBin;

pub const FORMAT_VERSION: u32 = 1;

/// A platform a package declares support for, e.g. `.iOS("17.0")` or `.macOS(.v14)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlatform {
    pub name: String,
    pub version: String,
}

/// The pieces of a manifest that decide whether a package can be built for a
/// device, and which files have to be copied into the app bundle.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMetadata {
    pub platforms: Vec<PackagePlatform>,
    /// Paths of asset catalogs / `.xcassets` folders found under the target roots.
    pub asset_catalogs: Vec<String>,
    /// Paths of copied resources (`.process`, `.copy` and plain files).
    pub resources: Vec<String>,
    /// Target names that build for iOS, i.e. that are not macOS-only.
    pub ios_targets: Vec<String>,
    /// Every target in the package.
    pub supported_targets: Vec<String>,
    /// Minimum iOS version declared by the manifest, when there is one.
    pub deployment_target: Option<String>,
}

impl PackageMetadata {
    /// The smallest iOS version the package declares, if any.
    pub fn minimum_ios(&self) -> Option<&PackagePlatform> {
        self.platforms
            .iter()
            .find(|platform| platform.name.eq_ignore_ascii_case("ios"))
    }

    /// Warnings worth showing before a build starts. Empty means "nothing to say".
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        if !self.platforms.is_empty() && self.minimum_ios().is_none() {
            let names: Vec<&str> = self
                .platforms
                .iter()
                .map(|platform| platform.name.as_str())
                .collect();
            warnings.push(format!(
                "Package declares support for {} but not iOS; building for a device may fail.",
                names.join(", ")
            ));
        }
        let missing: Vec<&String> = self
            .supported_targets
            .iter()
            .filter(|name| !self.ios_targets.contains(*name))
            .collect();
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|name| name.as_str()).collect();
            warnings.push(format!(
                "Target(s) {} cannot be built for iOS.",
                names.join(", ")
            ));
        }
        for catalog in &self.asset_catalogs {
            warnings.push(format!(
                "Asset catalog {} cannot be compiled on Linux; its assets will be missing.",
                catalog
            ));
        }
        warnings
    }

}

/// Relevant part of `swift package dump-package`. Everything is optional so a
/// manifest written for a different tools version still parses.
#[derive(Debug, Deserialize)]
struct SwiftPackageDump {
    name: String,
    #[serde(default)]
    targets: Vec<SwiftPackageTarget>,
    #[serde(default)]
    platforms: Vec<SwiftPackagePlatform>,
}

#[derive(Debug, Deserialize)]
struct SwiftPackageTarget {
    name: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    #[serde(rename = "type")]
    target_type: Option<String>,
    /// `.process(...)` / `.copy(...)` declarations.
    #[serde(default)]
    resources: Vec<SwiftPackageResource>,
    #[serde(default)]
    settings: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct SwiftPackageResource {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    rule: Option<serde_json::Value>,
}

/// A platform in the manifest. The declared version is either a string
/// (`"17.0"`) or an enum (`{"macos": {"_0": "v14"}}`), so keep it as `Value`.
#[derive(Debug, Deserialize)]
struct SwiftPackagePlatform {
    #[serde(default)]
    platform_name: Option<String>,
    #[serde(default)]
    version: Option<serde_json::Value>,
    #[serde(default)]
    options: Vec<serde_json::Value>,
}

impl PackageMetadata {
    fn from_dump(package: &SwiftPackageDump) -> Self {
        let mut platforms = Vec::new();
        for declared in &package.platforms {
            if let Some(name) = &declared.platform_name {
                platforms.push(PackagePlatform {
                    name: name.clone(),
                    version: format_platform_version(declared.version.as_ref()),
                });
            }
        }

        let mut resources = Vec::new();
        let mut asset_catalogs = Vec::new();
        for target in &package.targets {
            let root = PathBuf::from(target.path.clone().unwrap_or_else(|| {
                // SwiftPM's default locations.
                let base = format!("Sources/{}", target.name);
                base
            }));
            for resource in &target.resources {
                if let Some(path) = &resource.path {
                    let full = root.join(path);
                    let text = full.to_string_lossy().replace('\\', "/");
                    if text.ends_with(".xcassets") || text.contains(".xcassets/") {
                        asset_catalogs.push(text.clone());
                    }
                    resources.push(text);
                }
            }
        }

        // A target is "available on iOS" unless its settings exclude it. SwiftPM
        // does not expose the resolved conditionals through dump-package, so the
        // check is deliberately conservative: a `settings` entry mentioning
        // macOS or SwiftPM's unsupported-platform error is treated as a hint.
        let ios_targets = package
            .targets
            .iter()
            .filter(|target| !target.settings.iter().any(|setting| mentions_macos(setting)))
            .map(|target| target.name.clone())
            .collect();

        let supported_targets = package
            .targets
            .iter()
            .map(|target| target.name.clone())
            .collect();

        let deployment_target = platforms
            .iter()
            .find(|platform| platform.name.eq_ignore_ascii_case("ios"))
            .map(|platform| platform.version.clone())
            .filter(|version| !version.is_empty());

        PackageMetadata {
            platforms,
            asset_catalogs,
            resources,
            ios_targets,
            supported_targets,
            deployment_target,
        }
    }

    /// Finds asset catalogs and resource folders on disk, for manifests that do
    /// not declare them (a plain Xcode-style layout).
    fn discover_on_disk(root: &PathBuf, targets: &[String]) -> (Vec<String>, Vec<String>) {
        let mut catalogs = Vec::new();
        let mut directories = Vec::new();
        for target in targets {
            for base in [
                root.join("Sources").join(target),
                root.join(target),
            ] {
                if !base.is_dir() {
                    continue;
                }
                collect_resources(&base, &mut catalogs, &mut directories);
            }
        }
        let mut flattened = directories.clone();
        // Only the top-level folders matter: a copy of `Resources/` already
        // brings everything below it into the bundle.
        flattened.retain(|candidate| {
            !directories
                .iter()
                .any(|other| other != candidate && candidate.starts_with(&format!("{}/", other)))
        });
        (catalogs, flattened)
    }
}

/// Walks a target folder collecting `.xcassets` bundles and resource folders.
fn collect_resources(base: &PathBuf, catalogs: &mut Vec<String>, directories: &mut Vec<String>) {
    let entries = match std::fs::read_dir(base) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let text = path.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            if text.ends_with(".xcassets") {
                catalogs.push(text);
                continue;
            }
            if name == "Resources" || name == "assets" || name == "Assets" {
                directories.push(text);
                continue;
            }
        }
    }
}

fn mentions_macos(value: &serde_json::Value) -> bool {
    let text = value.to_string().to_lowercase();
    text.contains("macos") || text.contains("unsupportedplatform")
}

/// `"17.0"`, `{"_0": "v14"}` and `{"_0": null}` -> `"17.0"`, `"14"`, `""`.
fn format_platform_version(version: Option<&serde_json::Value>) -> String {
    match version {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Object(map)) => {
            for key in ["_0", "string", "version"] {
                if let Some(value) = map.get(key) {
                    let text = format_platform_version(Some(value));
                    if !text.is_empty() {
                        // `v14` is SwiftPM's short form for `14.0`.
                        return text.trim_start_matches('v').to_string();
                    }
                }
            }
            String::new()
        }
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

impl SwiftPackageDump {
    /// Reads what the manifest declares without running Swift.
    ///
    /// Detection must work before a toolchain is selected, so this parses
    /// `Package.swift` with the SwiftPM manifest parser only if it is already
    /// available, and otherwise keeps the metadata empty and falls back to
    /// looking at the target folders on disk.
    fn load(root: &PathBuf, targets: &[String], kind: &ProjectKind) -> PackageMetadata {
        if !matches!(
            kind,
            ProjectKind::CrosscodePackage | ProjectKind::SwiftPackage
        ) {
            return PackageMetadata::default();
        }
        if let Some(dump) = read_manifest_with_swift(root) {
            let mut metadata = PackageMetadata::from_dump(&dump);
            fill_missing_resources(&mut metadata, root, targets);
            return metadata;
        }
        PackageMetadata::discover(root, targets)
    }
}

/// Runs `swift package dump-package` when a `swift` is on PATH. Absence is not
/// an error: the metadata is a convenience, not a requirement.
fn read_manifest_with_swift(root: &PathBuf) -> Option<SwiftPackageDump> {
    let output = std::process::Command::new("swift")
        .arg("package")
        .arg("dump-package")
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Adds the resource folders that exist on disk but were not declared, and the
/// asset catalogs found next to the sources.
fn fill_missing_resources(metadata: &mut PackageMetadata, root: &PathBuf, targets: &[String]) {
    let (catalogs, directories) = PackageMetadata::discover_on_disk(root, targets);
    for catalog in catalogs {
        if !metadata.asset_catalogs.contains(&catalog) {
            metadata.asset_catalogs.push(catalog);
        }
    }
    for directory in directories {
        if !metadata.resources.contains(&directory) {
            metadata.resources.push(directory);
        }
    }
}

impl PackageMetadata {
    /// The metadata that can be read from the filesystem alone.
    fn discover(root: &PathBuf, targets: &[String]) -> Self {
        let (asset_catalogs, resources) = PackageMetadata::discover_on_disk(root, targets);
        PackageMetadata {
            platforms: Vec::new(),
            asset_catalogs,
            resources,
            ios_targets: targets.to_vec(),
            supported_targets: targets.to_vec(),
            deployment_target: None,
        }
    }
}



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
    /// Declared platforms, resources and asset catalogs, for SwiftPM packages.
    pub package_metadata: PackageMetadata,
    /// Anything worth telling the user about before a build starts.
    pub warnings: Vec<String>,
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

        let build_type = project_kind_label(&kind).to_string();
        // `swift package dump-package` needs a toolchain, which detection does
        // not have; read the manifest itself, and fall back to the filesystem
        // for packages whose manifest does not declare its resources.
        let package_metadata = SwiftPackageDump::load(&root, &targets, &kind);
        let warnings = package_metadata.warnings();

        Ok(ProjectInfo {
            kind,
            root: root.to_string_lossy().to_string(),
            build_root: build_root.to_string_lossy().to_string(),
            entry_point: entry_point.map(|path| path.to_string_lossy().to_string()),
            capabilities,
            targets,
            schemes,
            configurations: vec!["Debug".to_string(), "Release".to_string()],
            build_type,
            detected_files,
            package_metadata,
            warnings,
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

pub fn project_kind_label(kind: &ProjectKind) -> &'static str {
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

pub struct ProjectConfig {
    pub product: String,
    pub version_num: String,
    pub version_string: String,
    pub bundle_id: String,
    pub project_path: PathBuf,
    /// Platforms and resources declared by the manifest.
    pub metadata: PackageMetadata,
    /// Minimum iOS version, when the manifest declares one.
    pub minimum_ios: Option<String>,
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

        let metadata = PackageMetadata::from_dump(&package);

        Ok(ProjectConfig {
            product: package.name,
            version_num: toml_config.project.version_num,
            version_string: toml_config.project.version_string,
            bundle_id: toml_config.project.bundle_id,
            project_path,
            minimum_ios: metadata
                .minimum_ios()
                .map(|platform| platform.version.clone())
                .filter(|version| !version.is_empty()),
            metadata,
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

#[cfg(test)]
mod metadata_tests {
    use super::*;

    fn dump(json: &str) -> SwiftPackageDump {
        serde_json::from_str(json).expect("manifest fixture should parse")
    }

    #[test]
    fn reads_string_and_enum_platform_versions() {
        let package = dump(
            r#"{
                "name": "App",
                "targets": [],
                "platforms": [
                    { "platformName": "ios", "version": "17.0", "options": [] },
                    { "platformName": "macos", "version": { "_0": "v14" }, "options": [] }
                ]
            }"#,
        );
        let metadata = PackageMetadata::from_dump(&package);
        assert_eq!(metadata.platforms.len(), 2);
        assert_eq!(metadata.platforms[0].name, "ios");
        assert_eq!(metadata.platforms[0].version, "17.0");
        // SwiftPM's `v14` short form, with the enum wrapper flattened away.
        assert_eq!(metadata.platforms[1].version, "14");
    }

    #[test]
    fn a_platform_without_a_version_is_still_recorded() {
        let package = dump(
            r#"{"name":"App","targets":[],"platforms":[{"platformName":"ios","options":[]}]}"#,
        );
        let metadata = PackageMetadata::from_dump(&package);
        assert_eq!(metadata.platforms[0].version, "");
        assert!(metadata.minimum_ios().is_some());
        assert_eq!(metadata.minimum_ios().unwrap().version, "");
    }

    #[test]
    fn collects_declared_resources_and_asset_catalogs() {
        let package = dump(
            r#"{
                "name": "App",
                "platforms": [],
                "targets": [
                    {
                        "name": "App",
                        "path": "Sources/App",
                        "resources": [
                            { "path": "Assets.xcassets", "rule": { "process": {} } },
                            { "path": "Resources", "rule": { "copy": {} } }
                        ],
                        "settings": []
                    }
                ]
            }"#,
        );
        let metadata = PackageMetadata::from_dump(&package);
        assert_eq!(metadata.asset_catalogs, vec!["Sources/App/Assets.xcassets"]);
        assert_eq!(metadata.resources.len(), 2);
        // asset catalogs cannot be compiled on Linux, which is worth a warning
        assert!(metadata
            .warnings()
            .iter()
            .any(|warning| warning.contains("cannot be compiled on Linux")));
    }

    #[test]
    fn warns_when_ios_is_not_declared() {
        let package = dump(
            r#"{"name":"App","targets":[],"platforms":[{"platformName":"macos","version":"14","options":[]}]}"#,
        );
        let metadata = PackageMetadata::from_dump(&package);
        assert!(metadata
            .warnings()
            .iter()
            .any(|warning| warning.contains("not iOS")));
    }

    #[test]
    fn warns_about_targets_that_cannot_build_for_ios() {
        let package = dump(
            r#"{
                "name": "App",
                "platforms": [{"platformName": "ios", "version": "17.0", "options": []}],
                "targets": [
                    { "name": "App", "path": "Sources/App", "resources": [], "settings": [] },
                    { "name": "MacOnly", "path": "Sources/MacOnly", "resources": [], "settings": [] }
                ]
            }"#,
        );
        let mut metadata = PackageMetadata::from_dump(&package);
        // Pretend the manifest excluded `MacOnly` from iOS.
        metadata.ios_targets.retain(|name| name != "MacOnly");
        let warnings = metadata.warnings();
        assert!(
            warnings.iter().any(|warning| warning.contains("MacOnly")),
            "expected a warning about MacOnly, got {:?}",
            warnings
        );
    }

    #[test]
    fn says_nothing_about_a_package_without_platforms() {
        let package = dump(r#"{"name":"App","targets":[],"platforms":[]}"#);
        let metadata = PackageMetadata::from_dump(&package);
        assert!(metadata.warnings().is_empty());
    }

    #[test]
    fn tolerates_missing_fields() {
        // A tools version that does not emit `path`/`resources`/`settings` yet.
        let package = dump(r#"{"name":"App"}"#);
        let metadata = PackageMetadata::from_dump(&package);
        assert!(metadata.platforms.is_empty());
        assert!(metadata.resources.is_empty());
    }

    #[test]
    fn finds_asset_catalogs_on_disk() {
        let root = std::env::temp_dir().join(format!("crosscode-metadata-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Sources/App/Assets.xcassets")).unwrap();
        std::fs::create_dir_all(root.join("Sources/App/Resources/sub")).unwrap();
        std::fs::write(root.join("Sources/App/Resources/a.txt"), "a").unwrap();

        let metadata = PackageMetadata::discover(&root, &["App".to_string()]);
        assert_eq!(metadata.asset_catalogs.len(), 1);
        assert!(metadata.asset_catalogs[0].ends_with("Sources/App/Assets.xcassets"));
        // the nested folder is inside the reported one and must not repeat
        assert_eq!(metadata.resources.len(), 1);
        assert!(metadata.resources[0].ends_with("Sources/App/Resources"));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
