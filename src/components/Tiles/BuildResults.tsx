import { useMemo, useState } from "react";
import {
  Cancel,
  CheckCircle,
  ErrorOutline,
  InfoOutlined,
  RemoveCircleOutline,
  WarningAmber,
} from "@mui/icons-material";
import { Button, ButtonGroup, Typography } from "@mui/joy";
import {
  BuildProblem,
  openBuildLocation,
  ProblemSeverity,
  TestResult,
  TestStatus,
} from "../../utilities/build-results";
import "./BuildResults.css";

const problemIcons: Record<ProblemSeverity, React.ReactNode> = {
  error: <ErrorOutline color="error" />,
  warning: <WarningAmber color="warning" />,
  note: <InfoOutlined color="primary" />,
};

const testIcons: Record<TestStatus, React.ReactNode> = {
  passed: <CheckCircle color="success" />,
  failed: <Cancel color="error" />,
  skipped: <RemoveCircleOutline color="warning" />,
};

function shortPath(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts.slice(-3).join("/");
}

export function ProblemsPanel({ problems }: { problems: BuildProblem[] }) {
  const [filter, setFilter] = useState<"all" | ProblemSeverity>("all");
  const visible = useMemo(
    () => filter === "all" ? problems : problems.filter((problem) => problem.severity === filter),
    [filter, problems]
  );
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.filter((problem) => problem.severity === "warning").length;

  return (
    <div className="results-panel">
      <div className="results-toolbar">
        <Typography level="body-xs">{errors} errors · {warnings} warnings</Typography>
        <ButtonGroup size="sm" variant="plain">
          {(["all", "error", "warning", "note"] as const).map((value) => (
            <Button key={value} variant={filter === value ? "soft" : "plain"} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : `${value[0].toUpperCase()}${value.slice(1)}s`}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <div className="results-list">
        {visible.map((problem) => (
          <button className="result-row" key={problem.id} onClick={() => openBuildLocation(problem)}>
            <span className="result-icon">{problemIcons[problem.severity]}</span>
            <span className="result-copy">
              <span>{problem.message}</span>
              <small>{shortPath(problem.file)}:{problem.line}:{problem.column}</small>
            </span>
          </button>
        ))}
        {visible.length === 0 && <div className="results-empty">No matching build problems.</div>}
      </div>
    </div>
  );
}

export function TestsPanel({ results }: { results: TestResult[] }) {
  const [filter, setFilter] = useState<"all" | TestStatus>("all");
  const visible = useMemo(
    () => filter === "all" ? results : results.filter((result) => result.status === filter),
    [filter, results]
  );
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;

  return (
    <div className="results-panel">
      <div className="results-toolbar">
        <Typography level="body-xs">{passed} passed · {failed} failed</Typography>
        <ButtonGroup size="sm" variant="plain">
          {(["all", "passed", "failed", "skipped"] as const).map((value) => (
            <Button key={value} variant={filter === value ? "soft" : "plain"} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : `${value[0].toUpperCase()}${value.slice(1)}`}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      <div className="results-list">
        {visible.map((result) => (
          <div className="result-row test-result-row" key={result.id}>
            <span className="result-icon">{testIcons[result.status]}</span>
            <span className="result-copy">
              <span>{result.name}</span>
              <small>{result.suite}</small>
            </span>
            {result.duration !== undefined && <small>{result.duration.toFixed(3)}s</small>}
          </div>
        ))}
        {visible.length === 0 && <div className="results-empty">No matching test results yet.</div>}
      </div>
    </div>
  );
}
