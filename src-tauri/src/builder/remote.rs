//! Building and testing Xcode projects on a remote Mac over SSH.
//!
//! A remote command is assembled here (never by the frontend) so the profile is
//! validated once, quoted consistently and the same command is used by the
//! build, test and "test connection" commands.

use std::process::Command;

use serde::Deserialize;

use crate::builder::{
    config::{ProjectInfo, ProjectKind},
    swift::pipe_command,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMacProfile {
    pub enabled: bool,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub project_path: String,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub run_tests: Option<bool>,
    #[serde(default)]
    pub result_bundle_path: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
}

/// What to do once the project has been opened on the remote Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAction {
    Build,
    Test,
    Install,
}

impl RemoteAction {
    fn as_str(self) -> &'static str {
        match self {
            RemoteAction::Build => "build",
            RemoteAction::Test => "test",
            RemoteAction::Install => "build-for-testing",
        }
    }
}

impl RemoteMacProfile {
    /// Rejects anything that could escape the remote command line.
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() || self.user.trim().is_empty() {
            return Err("Remote Mac host and user are required".to_string());
        }
        if self.project_path.trim().is_empty() {
            return Err("Remote Mac project path is required".to_string());
        }
        if self.host.trim().parse::<std::net::IpAddr>().is_err()
            && !self
                .host
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':'))
        {
            return Err("Remote Mac host contains unsupported characters".to_string());
        }
        if !self
            .user
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
        {
            return Err("Remote Mac user contains unsupported characters".to_string());
        }
        if self.port == 0 {
            return Err("Remote Mac port must be between 1 and 65535".to_string());
        }
        if self.uses_identity() && self.identity_path().trim().is_empty() {
            return Err("Choose a private key file or switch the remote Mac to ssh-agent".to_string());
        }
        Ok(())
    }

    fn uses_identity(&self) -> bool {
        matches!(self.auth.as_deref(), Some("identity"))
    }

    fn identity_path(&self) -> &str {
        self.identity_file.as_deref().unwrap_or("").trim()
    }

    /// Existence is only checked for key authentication: agent auth has no file
    /// to point at, and the check must not run on a machine without the key
    /// (the UI may hold a profile that belongs to another machine).
    pub fn validate_identity_file(&self) -> Result<(), String> {
        if !self.uses_identity() {
            return Ok(());
        }
        let path = self.identity_path();
        if path.is_empty() {
            return Err("Choose a private key file or switch the remote Mac to ssh-agent".to_string());
        }
        if !std::path::Path::new(path).is_file() {
            return Err(format!("Private key not found: {}", path));
        }
        Ok(())
    }

    /// The ssh command, already pointed at the right host and port.
    pub fn ssh_command(&self) -> Command {
        let mut command = Command::new("ssh");
        command
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=8")
            // The remote Mac is usually not in a known_hosts file.
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-p")
            .arg(self.port.to_string());
        if self.uses_identity() {
            command.arg("-i").arg(self.identity_path());
        }
        command.arg(format!("{}@{}", self.user, self.host));
        command
    }

    /// The `xcodebuild` invocation for a project or workspace.
    pub fn xcodebuild_command(
        info: &ProjectInfo,
        action: RemoteAction,
        target: &str,
        scheme: &str,
        configuration: &str,
    ) -> Result<String, String> {
        let entry = info
            .entry_point
            .as_ref()
            .ok_or("Xcode project entry point is missing")?;
        let entry_name = std::path::Path::new(entry)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Xcode project entry point has an invalid name")?;
        let project_flag = if matches!(info.kind, ProjectKind::XcodeProject) {
            "-project"
        } else {
            "-workspace"
        };
        let mut arguments = vec![project_flag.to_string(), shell_quote(entry_name)];
        append_scheme_and_configuration(&mut arguments, target, scheme, configuration);
        arguments.push(action.as_str().to_string());
        Ok(format!("xcodebuild {}", arguments.join(" ")))
    }
}

/// `xcodebuild` selection arguments: a scheme wins over a target, exactly like
/// the local command builder.
pub fn append_scheme_and_configuration(
    arguments: &mut Vec<String>,
    target: &str,
    scheme: &str,
    configuration: &str,
) {
    if !scheme.trim().is_empty() {
        arguments.push("-scheme".to_string());
        arguments.push(shell_quote(scheme));
    } else if !target.trim().is_empty() {
        arguments.push("-target".to_string());
        arguments.push(shell_quote(target));
    }
    if !configuration.trim().is_empty() {
        arguments.push("-configuration".to_string());
        arguments.push(shell_quote(configuration));
    }
}

/// A single-quoted POSIX shell word — `sh -c` compatible and safe for `&&`.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\\"'\\\"'"))
}

/// Runs `command` inside the remote project directory.
pub fn remote_project_command(profile: &RemoteMacProfile, command: &str) -> String {
    format!(
        "cd {} && {}",
        shell_quote(&profile.project_path),
        command
    )
}

/// Runs `xcodebuild -version` on the remote Mac to check the connection.
pub async fn test_connection(
    window: &tauri::Window,
    profile: &RemoteMacProfile,
) -> Result<(), String> {
    profile.validate()?;
    profile.validate_identity_file()?;
    let mut command = profile.ssh_command();
    command.arg("xcodebuild -version");
    pipe_command(&mut command, window, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builder::config::{ProjectInfo, ProjectKind};

    fn profile() -> RemoteMacProfile {
        RemoteMacProfile {
            enabled: true,
            host: "mac.local".to_string(),
            user: "dev".to_string(),
            port: 22,
            project_path: "/Users/dev/My App".to_string(),
            auth: None,
            identity_file: None,
            run_tests: None,
            result_bundle_path: None,
            destination: None,
        }
    }

    fn info(kind: ProjectKind) -> ProjectInfo {
        ProjectInfo {
            kind,
            root: "/tmp/App".to_string(),
            build_root: "/tmp/App".to_string(),
            entry_point: Some("/tmp/App/App.xcodeproj".to_string()),
            capabilities: Vec::new(),
            targets: Vec::new(),
            schemes: Vec::new(),
            configurations: Vec::new(),
            build_type: String::new(),
            detected_files: Vec::new(),
        }
    }

    #[test]
    fn rejects_missing_fields() {
        let mut broken = profile();
        broken.host = String::new();
        assert!(broken.validate().is_err());

        let mut broken = profile();
        broken.user = "dev; rm -rf /".to_string();
        assert!(broken.validate().is_err());

        let mut broken = profile();
        broken.port = 0;
        assert!(broken.validate().is_err());
    }

    #[test]
    fn identity_auth_requires_a_path() {
        let mut identified = profile();
        identified.auth = Some("identity".to_string());
        assert!(identified.validate().is_err());

        identified.identity_file = Some("/tmp/key".to_string());
        assert!(identified.validate().is_ok());
        // the file does not exist, which is a separate error message
        assert!(identified.validate_identity_file().is_err());

        let agent = profile();
        assert!(agent.validate_identity_file().is_ok());
    }

    // Long option: assert the ssh arguments rather than the whole vector.
    #[test]
    fn ssh_command_carries_the_port_and_key() {
        let mut identified = profile();
        identified.port = 2222;
        identified.auth = Some("identity".to_string());
        identified.identity_file = Some("/tmp/key".to_string());
        let command = identified.ssh_command();
        let arguments: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect();
        assert!(arguments.contains(&"-p".to_string()));
        assert!(arguments.contains(&"2222".to_string()));
        assert!(arguments.contains(&"-i".to_string()));
        assert!(arguments.contains(&"/tmp/key".to_string()));
        assert!(arguments.contains(&"dev@mac.local".to_string()));
        assert!(arguments.contains(&"StrictHostKeyChecking=accept-new".to_string()));
    }

    #[test]
    fn quotes_paths_with_spaces() {
        let profile = profile();
        assert_eq!(
            remote_project_command(&profile, "xcodebuild build"),
            "cd '/Users/dev/My App' && xcodebuild build"
        );
    }

    #[test]
    fn quotes_embedded_single_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\\"'\\\"'s'");
    }

    #[test]
    fn builds_the_xcodebuild_command_for_a_project_and_a_workspace() {
        let project = RemoteMacProfile::xcodebuild_command(
            &info(ProjectKind::XcodeProject),
            RemoteAction::Build,
            "",
            "MyScheme",
            "Debug",
        )
        .unwrap();
        assert_eq!(
            project,
            "xcodebuild -project 'App.xcodeproj' -scheme 'MyScheme' -configuration 'Debug' build"
        );

        let workspace = RemoteMacProfile::xcodebuild_command(
            &info(ProjectKind::XcodeWorkspace),
            RemoteAction::Test,
            "MyTarget",
            "",
            "Release",
        )
        .unwrap();
        assert_eq!(
            workspace,
            "xcodebuild -workspace 'App.xcodeproj' -target 'MyTarget' -configuration 'Release' test"
        );
    }

    #[test]
    fn a_scheme_wins_over_a_target() {
        let mut arguments = Vec::new();
        append_scheme_and_configuration(&mut arguments, "Target", "Scheme", "");
        assert_eq!(arguments, vec!["-scheme", "'Scheme'"]);
    }
}
