import { describe, expect, test } from "bun:test";
import {
  defaultRemoteMacProfile,
  isRemoteMacUsable,
  mapRemoteToLocalPath,
  normalizeRemoteMacProfile,
  suggestRemoteProjectPath,
} from "./remote-mac";

describe("normalizeRemoteMacProfile", () => {
  test("fills the fields a profile stored by an older version lacks", () => {
    const legacy = {
      enabled: true,
      host: "mac.local",
      user: "dev",
      port: 22,
      projectPath: "/Users/dev/App",
    };
    expect(normalizeRemoteMacProfile(legacy)).toEqual({
      ...defaultRemoteMacProfile,
      ...legacy,
    });
  });

  test("coerces unknown or missing values", () => {
    expect(normalizeRemoteMacProfile(null).auth).toBe("agent");
    expect(normalizeRemoteMacProfile({ auth: "password" as never }).auth).toBe("agent");
    expect(normalizeRemoteMacProfile({ auth: "identity" }).auth).toBe("identity");
    expect(normalizeRemoteMacProfile({ port: 0 }).port).toBe(22);
    expect(normalizeRemoteMacProfile({ port: 2222 }).port).toBe(2222);
    expect(normalizeRemoteMacProfile({ runTests: 1 as never }).runTests).toBe(false);
  });
});

describe("isRemoteMacUsable", () => {
  test("requires the host, user, project path and the switch", () => {
    const base = { ...defaultRemoteMacProfile, host: "mac.local", user: "dev", projectPath: "/Users/dev/App" };
    expect(isRemoteMacUsable({ ...base, enabled: true })).toBe(true);
    expect(isRemoteMacUsable({ ...base, enabled: false })).toBe(false);
    expect(isRemoteMacUsable({ ...base, enabled: true, host: "  " })).toBe(false);
    expect(isRemoteMacUsable({ ...base, enabled: true, user: "" })).toBe(false);
    expect(isRemoteMacUsable({ ...base, enabled: true, projectPath: "" })).toBe(false);
  });
});

describe("mapRemoteToLocalPath", () => {
  test("maps build problems back into the workspace", () => {
    expect(
      mapRemoteToLocalPath("/Users/dev/App/App/View.swift", "/Users/dev/App", "D:/Code/App")
    ).toBe("D:/Code/App/App/View.swift");
    expect(mapRemoteToLocalPath("/Users/dev/App", "/Users/dev/App", "D:/Code/App")).toBe("D:/Code/App");
  });

  test("leaves paths outside the remote project alone", () => {
    expect(
      mapRemoteToLocalPath("/Applications/Xcode.app/x.swift", "/Users/dev/App", "D:/Code/App")
    ).toBe("/Applications/Xcode.app/x.swift");
    expect(mapRemoteToLocalPath("/Users/dev/Other/a.swift", "/Users/dev/App", "D:/Code/App")).toBe(
      "/Users/dev/Other/a.swift"
    );
  });

  test("tolerates missing roots and Windows separators", () => {
    expect(mapRemoteToLocalPath("/Users/dev/App/a.swift", "", "D:/Code/App")).toBe(
      "/Users/dev/App/a.swift"
    );
    expect(
      mapRemoteToLocalPath("\\Users\\dev\\App\\a.swift", "/Users/dev/App/", "D:\\Code\\App\\")
    ).toBe("D:/Code/App/a.swift");
  });
});

describe("suggestRemoteProjectPath", () => {
  test("keeps the folder name under the user's home", () => {
    expect(suggestRemoteProjectPath("/home/dev/Code/MyApp", "dev")).toBe("/Users/dev/MyApp");
    expect(suggestRemoteProjectPath("C:\\Code\\MyApp", "dev")).toBe("/Users/dev/MyApp");
  });

  test("gives up without a folder name or user", () => {
    expect(suggestRemoteProjectPath("/", "dev")).toBe("");
    expect(suggestRemoteProjectPath("/home/dev/MyApp", "")).toBe("");
  });
});
