export type RemoteMacAuth = "agent" | "identity";

export type RemoteMacProfile = {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  projectPath: string;
  /** `agent` uses ssh-agent / the default key, `identity` an explicit key file. */
  auth: RemoteMacAuth;
  /** Private key path, only for `auth: "identity"`. */
  identityFile: string;
  /** Run `xcodebuild test` instead of `build` for Xcode projects. */
  runTests: boolean;
  /** Build result bundle destination on the remote Mac (optional). */
  resultBundlePath: string;
  /** Limit the build to a destination, e.g. `generic/platform=iOS`. */
  destination: string;
};

export const defaultRemoteMacProfile: RemoteMacProfile = {
  enabled: false,
  host: "",
  user: "",
  port: 22,
  projectPath: "",
  auth: "agent",
  identityFile: "",
  runTests: false,
  resultBundlePath: "",
  destination: "",
};

/**
 * Fills in the fields a profile stored by an older version of CrossCode does
 * not have, so a saved workspace keeps working after an update.
 */
export function normalizeRemoteMacProfile(
  profile: Partial<RemoteMacProfile> | null | undefined
): RemoteMacProfile {
  return {
    ...defaultRemoteMacProfile,
    ...(profile ?? {}),
    auth: profile?.auth === "identity" ? "identity" : "agent",
    port: typeof profile?.port === "number" && profile.port > 0 ? profile.port : 22,
    runTests: profile?.runTests === true,
  };
}

/** Whether the profile has everything a remote command needs. */
export function isRemoteMacUsable(profile: RemoteMacProfile): boolean {
  return (
    profile.enabled &&
    profile.host.trim().length > 0 &&
    profile.user.trim().length > 0 &&
    profile.projectPath.trim().length > 0
  );
}

/**
 * Maps a path printed by the remote Mac back into the local workspace using the
 * remote project path and the local one, so a build problem opens the right
 * file. Anything outside the remote project path is returned unchanged.
 */
export function mapRemoteToLocalPath(
  remoteFile: string,
  remoteRoot: string,
  localRoot: string
): string {
  const file = remoteFile.replace(/\\/g, "/");
  const remote = (remoteRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const local = (localRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!remote || !local) return file;
  if (file === remote) return local;
  if (file.startsWith(`${remote}/`)) return `${local}${file.slice(remote.length)}`;
  return file;
}

/**
 * Best guess at the remote project directory from a local one: the folder name
 * is kept and placed under `~/` unless the user set something else. Used to
 * prefill the dialog, never to override what the user typed.
 */
export function suggestRemoteProjectPath(localPath: string, username: string): string {
  const name = (localPath || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
  if (!name) return "";
  return username ? `/Users/${username}/${name}` : "";
}
