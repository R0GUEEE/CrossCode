// Pure helpers for `TauriFileSystemProvider`.
//
// The provider itself imports the Monaco/VSCode file service, which makes it
// awkward to unit test; everything that can be decided without touching the
// filesystem lives here instead so `bun test src` can cover it.

/** The subset of VSCode's `FileChangeType` the watcher ever reports. */
export type WatchChangeKind = "added" | "updated" | "deleted";

/**
 * Maps a `@tauri-apps/plugin-fs` `WatchEvent["type"]` to the change kind the
 * file service understands.
 *
 * `null` means "do not report this event". `access` notifications fire whenever
 * a file is merely *read*, and turning those into `updated` events makes the
 * editor invalidate and reload the model it just wrote, which in turn triggers
 * another watch event — a feedback loop. `other` is notify's unclassified
 * bucket (metadata churn) and is ignored for the same reason.
 */
export function classifyWatchEvent(type: unknown): WatchChangeKind | null {
  // Watching a single file usually reports a plain `any`; that is a write.
  if (type === "any") return "updated";
  // `other` is notify's unclassified bucket and carries no change kind.
  if (typeof type !== "object" || type === null) return null;

  const record = type as Record<string, unknown>;
  if ("create" in record) return "added";
  if ("remove" in record) return "deleted";
  if ("modify" in record) {
    // A rename arrives as a modify with a `from`/`to` mode; the old path is
    // gone and the new one appeared, so they are a delete plus an add.
    const modify = record.modify;
    if (modify && typeof modify === "object") {
      const details = modify as Record<string, unknown>;
      if (details.kind === "rename") {
        if (details.mode === "from") return "deleted";
        if (details.mode === "to") return "added";
      }
    }
    return "updated";
  }
  return null;
}

/**
 * Decides whether a path reported by the filesystem watcher should be ignored.
 *
 * `excludes` comes straight from the file service and holds absolute paths,
 * paths relative to the watched folder and simple glob patterns — the subset of
 * `fast-glob` that is cheap to evaluate here. Supported wildcards: `*` (within a
 * segment), `**` (across segments) and `?` (a single character).
 */
export function isExcludedPath(
  changedPath: string,
  watchedPath: string,
  excludes: readonly string[] | undefined
): boolean {
  if (!excludes || excludes.length === 0) return false;

  const changed = normalise(changedPath);
  const root = normalise(watchedPath).replace(/\/+$/, "");

  for (const exclude of excludes) {
    if (!exclude) continue;
    const pattern = normalise(exclude).replace(/^\.\//, "");
    const isAbsolute = pattern.startsWith("/") || /^[a-z]:\//i.test(pattern);

    // Where the pattern is matched from: the whole path for absolute patterns,
    // the part below the watched folder otherwise.
    let candidate: string | null = null;
    if (isAbsolute) {
      candidate = changed;
    } else if (changed === root) {
      candidate = "";
    } else if (changed.startsWith(`${root}/`)) {
      candidate = changed.slice(root.length + 1);
    }
    if (candidate === null) continue;

    if (!/[*?]/.test(pattern)) {
      // A plain path excludes the entry itself and everything below it.
      const prefix = isAbsolute ? pattern.replace(/\/+$/, "") : pattern.replace(/\/+$/, "");
      if (candidate === prefix) return true;
      if (candidate.startsWith(`${prefix}/`)) return true;
      continue;
    }

    if (globToRegExp(pattern).test(candidate)) return true;
  }

  return false;
}

/** Translates one glob pattern to the `RegExp` used by {@link isExcludedPath}. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      // `**/` also matches zero segments, like it does in fast-glob.
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `FileSystemProviderErrorCode` member names, so this module stays pure. */
export type ProviderErrorCodeName =
  | "FileExists"
  | "FileNotFound"
  | "FileNotADirectory"
  | "FileIsADirectory"
  | "NoPermissions"
  | "FileExceedsStorageQuota"
  | "FileTooLarge"
  | "Unknown";

/**
 * Guesses the right `FileSystemProviderErrorCode` for a message coming out of
 * the Tauri fs plugin, which rejects with a plain (OS-flavoured) string. The
 * order matters: "No such file or directory (os error 2)" must be
 * `FileNotFound`, not `FileIsADirectory`.
 */
export function providerErrorCodeFor(message: unknown): ProviderErrorCodeName {
  const text = typeof message === "string" ? message : "";
  if (/no such file|not found|does not exist|enoent|os error 2\b/i.test(text)) {
    return "FileNotFound";
  }
  if (/not a directory|enotdir/i.test(text)) return "FileNotADirectory";
  if (/\bis a directory|eisdir/i.test(text)) return "FileIsADirectory";
  if (/already exists|eexist|\bexists\b/i.test(text)) return "FileExists";
  if (/permission|denied|eacces|eperm|forbidden/i.test(text)) {
    return "NoPermissions";
  }
  if (/quota/i.test(text)) return "FileExceedsStorageQuota";
  if (/too large|too big|etoolarge/i.test(text)) return "FileTooLarge";
  return "Unknown";
}
