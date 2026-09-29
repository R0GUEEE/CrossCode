import {
  Disposable,
  IDisposable,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  IFileChange,
  IFileDeleteOptions,
  IFileOverwriteOptions,
  IFileSystemProviderWithFileReadWriteCapability,
  IFileWriteOptions,
  IStat,
  IWatchOptions,
} from "@codingame/monaco-vscode-files-service-override";
import {
  Emitter,
  Event,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import * as fs from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import {
  classifyWatchEvent,
  isExcludedPath,
  providerErrorCodeFor,
  ProviderErrorCodeName,
  WatchChangeKind,
} from "./fs-provider-helpers";

const errorCodes: Record<ProviderErrorCodeName, FileSystemProviderErrorCode> = {
  FileExists: FileSystemProviderErrorCode.FileExists,
  FileNotFound: FileSystemProviderErrorCode.FileNotFound,
  FileNotADirectory: FileSystemProviderErrorCode.FileNotADirectory,
  FileIsADirectory: FileSystemProviderErrorCode.FileIsADirectory,
  NoPermissions: FileSystemProviderErrorCode.NoPermissions,
  FileExceedsStorageQuota: FileSystemProviderErrorCode.FileExceedsStorageQuota,
  FileTooLarge: FileSystemProviderErrorCode.FileTooLarge,
  Unknown: FileSystemProviderErrorCode.Unknown,
};

const changeTypes: Record<WatchChangeKind, FileChangeType> = {
  added: FileChangeType.ADDED,
  updated: FileChangeType.UPDATED,
  deleted: FileChangeType.DELETED,
};

/**
 * The fs plugin rejects with a plain string (and occasionally an `Error`), while
 * the file service wants an error carrying a `FileSystemProviderErrorCode` — the
 * code decides the message the user sees and how the operation is treated.
 */
function toProviderError(error: unknown): Error {
  if (error instanceof FileSystemProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return FileSystemProviderError.create(
    message,
    errorCodes[providerErrorCodeFor(message)]
  );
}

function toFileType(entry: fs.DirEntry): FileType {
  let type = FileType.Unknown;
  if (entry.isFile) type |= FileType.File;
  if (entry.isDirectory) type |= FileType.Directory;
  if (entry.isSymlink) type |= FileType.SymbolicLink;
  return type;
}

export default class TauriFileSystemProvider
  extends Disposable
  implements IFileSystemProviderWithFileReadWriteCapability
{
  private _onDidChangeFile: Emitter<readonly IFileChange[]>;
  private _onDidWatchError: Emitter<string>;

  capabilities: FileSystemProviderCapabilities;
  onDidChangeCapabilities: Event<void>;
  onDidChangeFile: Event<readonly IFileChange[]>;
  onDidWatchError: Event<string>;

  constructor(readonly: boolean) {
    super();
    this.onDidChangeCapabilities = Event.None;
    this._onDidChangeFile = new Emitter();
    this.onDidChangeFile = this._onDidChangeFile.event;
    this._onDidWatchError = new Emitter();
    this.onDidWatchError = this._onDidWatchError.event;
    this.capabilities =
      FileSystemProviderCapabilities.FileReadWrite |
      FileSystemProviderCapabilities.PathCaseSensitive;
    if (readonly) {
      this.capabilities |= FileSystemProviderCapabilities.Readonly;
    }
  }

  override dispose(): void {
    this._onDidChangeFile.dispose();
    this._onDidWatchError.dispose();
    super.dispose();
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    return await this.withPath(resource, (path) => fs.readFile(path));
  }

  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions) {
    const existed = await this.withPath(resource, (path) => fs.exists(path));
    if (!opts.overwrite && existed) {
      throw FileSystemProviderError.create(
        `Unable to write file '${resource.toString()}' (File exists)`,
        FileSystemProviderErrorCode.FileExists
      );
    }
    if (!opts.create && !existed) {
      throw FileSystemProviderError.create(
        `Unable to write file '${resource.toString()}' (File not found)`,
        FileSystemProviderErrorCode.FileNotFound
      );
    }
    await this.withPath(resource, (path) =>
      fs.writeFile(path, content, { create: true })
    );
    this._onDidChangeFile.fire([
      {
        type: existed ? FileChangeType.UPDATED : FileChangeType.ADDED,
        resource,
      },
    ]);
  }

  async stat(resource: URI): Promise<IStat> {
    const stat = await this.withPath(resource, (path) => fs.stat(path));
    // `FileType` is a bitfield: a symlink to a folder is both.
    let type = FileType.Unknown;
    if (stat.isFile) type |= FileType.File;
    if (stat.isDirectory) type |= FileType.Directory;
    if (stat.isSymlink) type |= FileType.SymbolicLink;
    // The file service expects milliseconds since the epoch — not the
    // millisecond *component* of the date, which is what this used to report.
    const mtime = stat.mtime ? stat.mtime.getTime() : 0;
    const birthtime = stat.birthtime ? stat.birthtime.getTime() : 0;
    return {
      type,
      ctime: Number.isFinite(birthtime) && birthtime > 0 ? birthtime : mtime,
      mtime: Number.isFinite(mtime) ? mtime : 0,
      size: stat.size,
    };
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const entries = await this.withPath(resource, (path) => fs.readDir(path));
    return entries.map((entry) => [entry.name, toFileType(entry)]);
  }

  async mkdir(resource: URI): Promise<void> {
    // The file service creates the parents itself (`mkdirp`), so `recursive`
    // only makes this tolerant of a folder that appeared in the meantime.
    await this.withPath(resource, (path) => fs.mkdir(path, { recursive: true }));
    this._onDidChangeFile.fire([{ type: FileChangeType.ADDED, resource }]);
  }

  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    await this.withPath(resource, (path) =>
      fs.remove(path, { recursive: opts.recursive })
    );
    this._onDidChangeFile.fire([{ type: FileChangeType.DELETED, resource }]);
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    const exists = await this.withPath(to, (path) => fs.exists(path));
    if (!opts.overwrite && exists) {
      throw FileSystemProviderError.create(
        `Unable to rename '${from.toString()}' to '${to.toString()}' (File exists)`,
        FileSystemProviderErrorCode.FileExists
      );
    }
    const source = await this.path(from);
    const target = await this.path(to);
    try {
      await fs.rename(source, target);
    } catch (error) {
      throw toProviderError(error);
    }
    this._onDidChangeFile.fire([
      { type: FileChangeType.DELETED, resource: from },
      { type: FileChangeType.ADDED, resource: to },
    ]);
  }

  watch(resource: URI, opts: IWatchOptions): IDisposable {
    let disposed = false;
    let unwatch: fs.UnwatchFn | undefined;

    const fire = (changes: IFileChange[]) => {
      if (!disposed && changes.length) {
        this._onDidChangeFile.fire(changes);
      }
    };

    (async () => {
      try {
        const watchedPath = await this.path(resource);
        const stop = await fs.watchImmediate(
          watchedPath,
          (event) => {
            const kind = classifyWatchEvent(event.type);
            if (!kind) return;
            const paths = (event.paths ?? []).filter(
              (path) => !isExcludedPath(path, watchedPath, opts.excludes)
            );
            // Some backends report an event without the path it belongs to;
            // fall back to the watched resource so the change is not lost.
            if (paths.length === 0) {
              fire([{ type: changeTypes[kind], resource }]);
              return;
            }
            void (async () => {
              const changes: IFileChange[] = [];
              for (const path of paths) {
                changes.push({
                  type: changeTypes[kind],
                  resource: await this.uriFor(path),
                });
              }
              fire(changes);
            })();
          },
          { recursive: opts.recursive }
        );
        if (disposed) {
          stop();
        } else {
          unwatch = stop;
        }
      } catch (error) {
        this._onDidWatchError.fire(
          `Unable to watch ${resource.toString()}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();

    return {
      dispose: () => {
        disposed = true;
        unwatch?.();
        unwatch = undefined;
      },
    };
  }

  /** Runs `operation` against the plugin's path form of `resource`. */
  private async withPath<T>(
    resource: URI,
    operation: (path: string) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(await this.path(resource));
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /**
   * Path of a resource in the form the fs plugin understands: the internal
   * (Linux/WSL) path, converted when running on Windows.
   */
  private async path(resource: URI): Promise<string> {
    if (platform() === "windows") {
      return await invoke<string>("windows_path", { path: resource.path });
    }
    return resource.fsPath;
  }

  /**
   * Inverse of {@link path}: watcher events come back in the plugin's own path
   * form, so convert before building a resource out of them.
   */
  private async uriFor(path: string): Promise<URI> {
    if (platform() === "windows") {
      return URI.file(await invoke<string>("linux_path", { path }));
    }
    return URI.file(path);
  }
}
