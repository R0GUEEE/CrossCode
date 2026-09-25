export type ProblemSeverity = "error" | "warning" | "note";

export type BuildProblem = {
  id: string;
  file: string;
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
};

export type TestStatus = "passed" | "failed" | "skipped";

export type TestResult = {
  id: string;
  suite: string;
  name: string;
  status: TestStatus;
  duration?: number;
};

const problemPattern = /^(.*\.(?:swift|m|mm|h|hpp|c|cc|cpp)):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/i;
const xctestPattern = /^Test Case ['"]-?\[?([^\]']+?)[ .]([^\]']+?)\]?['"] (passed|failed|skipped)(?: \(([\d.]+) seconds\))?\.?$/i;
const swiftTestPattern = /^[✔✘]\s+Test\s+["“](.+?)["”]\s+(passed|failed|skipped)(?: after ([\d.]+) seconds?)?/i;

function slash(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

export function resolveBuildPath(rawFile: string, projectRoot: string, remoteRoot = ""): string {
  const file = slash(rawFile.trim());
  const local = slash(projectRoot);
  const remote = slash(remoteRoot);

  if (remote && (file === remote || file.startsWith(`${remote}/`))) {
    return `${local}${file.slice(remote.length)}`;
  }
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) return file;
  return local ? `${local}/${file.replace(/^\.\//, "")}` : file;
}

export function parseBuildProblems(
  lines: string[],
  projectRoot: string,
  remoteRoot = ""
): BuildProblem[] {
  const unique = new Map<string, BuildProblem>();
  for (const rawLine of lines) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const match = line.match(problemPattern);
    if (!match) continue;
    const problem: BuildProblem = {
      id: `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`,
      file: resolveBuildPath(match[1], projectRoot, remoteRoot),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4].toLowerCase() as ProblemSeverity,
      message: match[5].trim(),
    };
    unique.set(problem.id, problem);
  }
  return [...unique.values()];
}

export function parseTestResults(lines: string[]): TestResult[] {
  const results = new Map<string, TestResult>();
  for (const rawLine of lines) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const xctest = line.match(xctestPattern);
    if (xctest) {
      const suite = xctest[1].trim();
      const name = xctest[2].trim();
      const id = `${suite}.${name}`;
      results.set(id, {
        id,
        suite,
        name,
        status: xctest[3].toLowerCase() as TestStatus,
        duration: xctest[4] ? Number(xctest[4]) : undefined,
      });
      continue;
    }
    const swiftTest = line.match(swiftTestPattern);
    if (swiftTest) {
      const name = swiftTest[1].trim();
      results.set(name, {
        id: name,
        suite: "Swift Testing",
        name,
        status: swiftTest[2].toLowerCase() as TestStatus,
        duration: swiftTest[3] ? Number(swiftTest[3]) : undefined,
      });
    }
  }
  return [...results.values()];
}

export function openBuildLocation(problem: Pick<BuildProblem, "file" | "line" | "column">) {
  window.dispatchEvent(
    new CustomEvent("crosscode:open-location", { detail: problem })
  );
}
