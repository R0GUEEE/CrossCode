// Import an Xcode project: pick a project, review the plan, convert it into a
// CrossCode (SwiftPM) package.

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, CardContent, Checkbox, Divider, Link, Typography } from "@mui/joy";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useToast } from "react-toast-plus";
import logo from "../assets/logo.png";
import {
  ImportError,
  planImport,
  type ImportPlan,
} from "../xcode-import/plan";
import {
  findXcodeProjects,
  joinPath,
  loadProjectFiles,
  normalizePath,
} from "../xcode-import/project-files";
import { useIDE } from "../utilities/IDEContext";
import "./Onboarding.css";
import "./ImportXcode.css";

type ImportReport = {
  packageDir: string;
  written: string[];
  copied: string[];
  skipped: string[];
};

export default () => {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { selectedToolchain } = useIDE();

  const [folder, setFolder] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [destination, setDestination] = useState<string>("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  const pickFolder = useCallback(
    async (override?: string) => {
      const picked = override ?? (await openFolderDialog({
        directory: true,
        multiple: false,
        title: "Select the folder containing the Xcode project",
      }));
      if (!picked || Array.isArray(picked)) return;

      const normalized = normalizePath(picked);
      setFolder(normalized);
      setPlan(null);
      setProjects([]);
      setProject(null);

      const found = await findXcodeProjects(normalized);
      setProjects(found);
      if (found.length === 1) {
        setProject(found[0]);
      } else if (found.length === 0) {
        addToast.error("No .xcodeproj found in that folder");
      }
    },
    [addToast]
  );

  const buildPlan = useCallback(
    async (xcodeproj: string) => {
      setBusy(true);
      try {
        const projectDirectory = normalizePath(xcodeproj.substring(0, xcodeproj.lastIndexOf("/")));
        const pbx = await readTextFile(joinPath(xcodeproj, "project.pbxproj"));
        const files = await loadProjectFiles(projectDirectory);

        const built = planImport(pbx, xcodeproj, {
          packageRoot: destination.length > 0 ? normalizePath(destination) : projectDirectory,
          readFile: (path) => files.plists.get(normalizePath(path)) ?? null,
          listDirectory: (path) => files.listings.get(normalizePath(path)) ?? [],
        });
        setPlan(built);
        if (destination.length === 0) setDestination(built.packageRoot);
      } catch (error) {
        setPlan(null);
        addToast.error(
          error instanceof ImportError
            ? error.message
            : `Failed to read the project: ${String(error)}`
        );
      } finally {
        setBusy(false);
      }
    },
    [addToast, destination]
  );

  const runImport = useCallback(async () => {
    if (!plan) return;
    if (!selectedToolchain) {
      addToast.error("Select a Swift toolchain first");
      return;
    }
    setBusy(true);
    try {
      const report = await invoke<ImportReport>("apply_xcode_import", {
        packageRoot: destination.length > 0 ? normalizePath(destination) : plan.packageRoot,
        files: plan.files,
        copies: plan.copies,
        overwrite,
      });
      addToast.success(`Imported into ${report.packageDir}`);
      for (const name of report.skipped.slice(0, 5)) {
        addToast.info(`Skipped ${name}`);
      }
      navigate(`/ide/${encodeURIComponent(report.packageDir)}`);
    } catch (error) {
      addToast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, [addToast, destination, navigate, overwrite, plan, selectedToolchain]);

  const converted = plan?.targets.filter((target) => target.swiftPackageTargetType !== null) ?? [];
  const skipped = plan?.targets.filter((target) => target.swiftPackageTargetType === null) ?? [];

  return (
    <div className="onboarding import-page">
      <div className="onboarding-header">
        <img src={logo} alt="CrossCode Logo" className="onboarding-logo" />
        <div>
          <Typography level="h1">Import an Xcode project</Typography>
          <Typography level="body-sm">
            CrossCode generates a SwiftPM package that points at the project's existing
            sources, so both tools can keep working on it.
          </Typography>
        </div>
      </div>

      <div className="import-actions">
        <Button size="lg" onClick={() => void pickFolder()}>
          Select Project Folder
        </Button>
        {folder && <Typography level="body-sm">{folder}</Typography>}
      </div>

      {projects.length > 1 && (
        <Card variant="soft">
          <Typography level="h3">Select a project</Typography>
          <div className="import-projects">
            {projects.map((candidate) => (
              <Button
                key={candidate}
                variant={candidate === project ? "solid" : "outlined"}
                onClick={() => {
                  setProject(candidate);
                  setPlan(null);
                }}
              >
                {candidate.substring(candidate.lastIndexOf("/") + 1)}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {project && !plan && (
        <div className="import-actions">
          <Typography level="body-md">{project}</Typography>
          <Button loading={busy} onClick={() => void buildPlan(project)}>
            Analyse Project
          </Button>
        </div>
      )}

      {plan && (
        <Card variant="soft" className="import-plan">
          <CardContent>
            <Typography level="h3">Import plan</Typography>
            <Typography level="body-sm">
              Package <b>{plan.packageName}</b> · iOS {plan.settings.IPHONEOS_DEPLOYMENT_TARGET ?? "17.0"} ·
              bundle id {plan.targets.find((target) => target.kind === "app")?.bundleId}
            </Typography>
            <Divider sx={{ my: "var(--padding-sm)" }} />

            <Typography level="title-sm">Targets</Typography>
            <ul className="import-list">
              {converted.map((target) => (
                <li key={target.id}>
                  <b>{target.name}</b> → {target.swiftPackageTargetType} target at{" "}
                  <code>{target.path}</code> ({target.sources.length} sources)
                </li>
              ))}
              {skipped.map((target) => (
                <li key={target.id} className="import-muted">
                  <b>{target.name}</b> — {target.skippedReason}
                </li>
              ))}
            </ul>

            {plan.packages.length > 0 && (
              <>
                <Typography level="title-sm">Swift package dependencies</Typography>
                <ul className="import-list">
                  {plan.packages.map((dependency) => (
                    <li key={dependency.identity}>
                      {dependency.identity} ({dependency.kind}) — <code>{dependency.location}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <Typography level="title-sm">Files</Typography>
            <ul className="import-list">
              {plan.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>
                </li>
              ))}
              <li>{plan.copies.length} resource file(s) copied into <code>Resources/</code></li>
            </ul>

            {plan.warnings.length > 0 && (
              <>
                <Typography level="title-sm">Warnings</Typography>
                <ul className="import-list import-warnings">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            )}

            <Divider sx={{ my: "var(--padding-sm)" }} />
            <div className="import-options">
              <label>
                Destination
                <input
                  type="text"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                />
              </label>
              <div className="import-checkbox">
                <Checkbox
                  checked={overwrite}
                  onChange={(event) => setOverwrite(event.target.checked)}
                />
                <span>Replace an existing Package.swift / crosscode.toml</span>
              </div>
            </div>

            <div className="import-actions">
              <Button loading={busy} onClick={() => void runImport()}>
                Import
              </Button>
              <Button variant="outlined" onClick={() => setPlan(null)}>
                Back
              </Button>
              <Link
                level="body-sm"
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/");
                }}
              >
                Cancel
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
