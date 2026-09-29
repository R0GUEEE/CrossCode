import { describe, expect, test } from "bun:test";
import {
  classifyWatchEvent,
  isExcludedPath,
  providerErrorCodeFor,
} from "./fs-provider-helpers";

describe("classifyWatchEvent", () => {
  test("maps create/remove/modify to added/deleted/updated", () => {
    expect(classifyWatchEvent({ create: { kind: "file" } })).toBe("added");
    expect(classifyWatchEvent({ create: { kind: "folder" } })).toBe("added");
    expect(classifyWatchEvent({ remove: { kind: "file" } })).toBe("deleted");
    expect(classifyWatchEvent({ modify: { kind: "data", mode: "content" } })).toBe(
      "updated"
    );
  });

  test("splits renames into a delete and an add", () => {
    expect(classifyWatchEvent({ modify: { kind: "rename", mode: "from" } })).toBe(
      "deleted"
    );
    expect(classifyWatchEvent({ modify: { kind: "rename", mode: "to" } })).toBe(
      "added"
    );
    expect(classifyWatchEvent({ modify: { kind: "rename", mode: "both" } })).toBe(
      "updated"
    );
  });

  test("ignores events that must not invalidate cached models", () => {
    // Reading a file (or touching its metadata) must not reload the editor.
    expect(classifyWatchEvent({ access: { kind: "open", mode: "read" } })).toBeNull();
    expect(classifyWatchEvent({ access: { kind: "close", mode: "write" } })).toBeNull();
    expect(classifyWatchEvent("other")).toBeNull();
    expect(classifyWatchEvent(undefined)).toBeNull();
  });

  test("treats a bare 'any' as a write", () => {
    expect(classifyWatchEvent("any")).toBe("updated");
  });
});

describe("isExcludedPath", () => {
  test("matches patterns relative to the watched folder", () => {
    expect(isExcludedPath("/work/App/.git/index", "/work/App", [".git"])).toBe(true);
    expect(isExcludedPath("/work/App/.git/objects/ab", "/work/App", [".git"])).toBe(true);
    expect(isExcludedPath("/work/App/Sources/App.swift", "/work/App", [".git"])).toBe(false);
  });

  test("supports globs", () => {
    expect(isExcludedPath("/work/App/.build/a/b.o", "/work/App", [".build/**"])).toBe(true);
    expect(isExcludedPath("/work/App/notes.txt", "/work/App", ["**/*.txt"])).toBe(true);
    expect(isExcludedPath("/work/App/Sources/App.swift", "/work/App", ["**/*.txt"])).toBe(false);
    expect(isExcludedPath("/work/App/Sources/App.swift", "/work/App", ["Sources/?.swift"])).toBe(false);
    expect(isExcludedPath("/work/App/Sources/A.swift", "/work/App", ["Sources/?.swift"])).toBe(true);
    expect(isExcludedPath("/work/App/App.swift", "/work/App", ["**/App.swift"])).toBe(true);
  });

  test("handles absolute patterns and Windows separators", () => {
    expect(isExcludedPath("C:\\work\\App\\.build\\x", "C:\\work\\App", ["C:/work/App/.build"])).toBe(true);
    expect(isExcludedPath("C:\\work\\App\\src\\a.swift", "C:\\work\\App", ["C:/other"])).toBe(false);
  });

  test("ignores paths outside the watched folder and empty exclude lists", () => {
    expect(isExcludedPath("/elsewhere/a.swift", "/work/App", ["Sources"])).toBe(false);
    expect(isExcludedPath("/work/App/Sources/a.swift", "/work/App", [])).toBe(false);
    expect(isExcludedPath("/work/App/Sources/a.swift", "/work/App", undefined)).toBe(false);
  });
});

describe("providerErrorCodeFor", () => {
  test("recognises the fs plugin's error strings", () => {
    expect(providerErrorCodeFor("No such file or directory (os error 2)")).toBe("FileNotFound");
    expect(providerErrorCodeFor("path `x` already exists")).toBe("FileExists");
    expect(providerErrorCodeFor("forbidden path: /etc/passwd")).toBe("NoPermissions");
    expect(providerErrorCodeFor("Not a directory (os error 20)")).toBe("FileNotADirectory");
    expect(providerErrorCodeFor("Is a directory (os error 21)")).toBe("FileIsADirectory");
    expect(providerErrorCodeFor("something odd happened")).toBe("Unknown");
  });

  test("prefers FileNotFound over the 'directory' patterns", () => {
    expect(providerErrorCodeFor("Error: ENOENT: no such file or directory")).toBe("FileNotFound");
    expect(providerErrorCodeFor("target does not exist")).toBe("FileNotFound");
  });
});
