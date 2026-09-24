// Filesystem helpers for the Xcode project importer.
//
// The importer needs to read `project.pbxproj` and, while planning, a handful
// of files and directory listings. Those are loaded up-front into a cache so
// the planner itself can stay synchronous (and therefore unit testable).

import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

export type ProjectFiles = {
  /** directory -> absolute paths of its entries */
  listings: Map<string, string[]>;
  /** absolute path -> file contents (plists only) */
  plists: Map<string, string>;
};

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".build",
  ".crosscode",
  "DerivedData",
  "node_modules",
  "Pods",
  "Carthage",
]);

/** Normalises to "/" separators so paths compare consistently across platforms. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function joinPath(base: string, child: string): string {
  return `${normalizePath(base)}/${child}`;
}

/**
 * Walks a project directory collecting directory listings and Info.plist style
 * files. The walk is bounded: huge trees only need the parts the planner reads.
 */
export async function loadProjectFiles(
  root: string,
  options: { maxDirectories?: number; maxPlistBytes?: number } = {}
): Promise<ProjectFiles> {
  const maxDirectories = options.maxDirectories ?? 4000;
  const maxPlistBytes = options.maxPlistBytes ?? 512 * 1024;

  const listings = new Map<string, string[]>();
  const plists = new Map<string, string>();
  const queue: string[] = [normalizePath(root)];
  let visited = 0;

  while (queue.length > 0 && visited < maxDirectories) {
    const directory = queue.shift() as string;
    if (listings.has(directory)) continue;

    let entries;
    try {
      entries = await readDir(directory);
    } catch {
      listings.set(directory, []);
      visited += 1;
      continue;
    }

    const paths: string[] = [];
    for (const entry of entries) {
      const path = joinPath(directory, entry.name);
      paths.push(path);
      if (entry.isDirectory) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".plist")) continue;
      try {
        const contents = await readTextFile(path);
        if (contents.length <= maxPlistBytes) plists.set(path, contents);
      } catch {
        // unreadable plists simply fall back to the generated default
      }
    }
    listings.set(directory, paths);
    visited += 1;
  }

  return { listings, plists };
}

/** The `.xcodeproj` bundles inside a directory. */
export async function findXcodeProjects(directory: string): Promise<string[]> {
  try {
    const entries = await readDir(normalizePath(directory));
    return entries
      .filter((entry) => entry.name.toLowerCase().endsWith(".xcodeproj"))
      .map((entry) => joinPath(normalizePath(directory), entry.name));
  } catch {
    return [];
  }
}

/** The SwiftPM packages below a directory (folders containing Package.swift). */
export async function findSwiftPackages(
  root: string,
  options: { maxDepth?: number } = {}
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 3;
  const found: string[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: normalizePath(root), depth: 0 }];

  while (queue.length > 0) {
    const { directory, depth } = queue.shift() as { directory: string; depth: number };
    let entries;
    try {
      entries = await readDir(directory);
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isFile && entry.name === "Package.swift")) {
      found.push(directory);
      continue; // nested packages are not part of this one
    }
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push({ directory: joinPath(directory, entry.name), depth: depth + 1 });
    }
  }

  return found.sort();
}
