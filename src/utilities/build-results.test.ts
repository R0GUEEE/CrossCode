import { describe, expect, test } from "bun:test";
import { parseBuildProblems, parseTestResults, resolveBuildPath } from "./build-results";

describe("build result parsing", () => {
  test("parses and deduplicates Swift diagnostics", () => {
    const lines = [
      "Sources/App.swift:12:7: error: cannot find 'thing' in scope",
      "Sources/App.swift:12:7: error: cannot find 'thing' in scope",
      "Sources/App.swift:9:1: warning: immutable value was never used",
    ];
    const problems = parseBuildProblems(lines, "/work/App");
    expect(problems).toHaveLength(2);
    expect(problems[0].file).toBe("/work/App/Sources/App.swift");
    expect(problems[0].severity).toBe("error");
  });

  test("maps remote Mac paths into the local workspace", () => {
    expect(resolveBuildPath(
      "/Users/dev/App/Sources/View.swift",
      "D:/Code/App",
      "/Users/dev/App"
    )).toBe("D:/Code/App/Sources/View.swift");
  });

  test("parses XCTest and Swift Testing results", () => {
    const results = parseTestResults([
      "Test Case '-[AppTests.LoginTests testValidLogin]' passed (0.042 seconds).",
      "✔ Test “Creates a profile” passed after 0.003 seconds.",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("passed");
    expect(results[1].name).toBe("Creates a profile");
  });
});
