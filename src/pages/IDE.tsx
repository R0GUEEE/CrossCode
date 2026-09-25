import Splitter, { GutterTheme, SplitDirection } from "@devbookhq/splitter";
import Tile from "../components/Tiles/Tile";
import FileExplorer from "../components/Tiles/FileExplorer";
import { useCallback, useContext, useEffect, useState } from "react";
import Editor from "../components/Tiles/Editor";
import MenuBar from "../components/Menu/MenuBar";
import "./IDE.css";
import { StoreContext, useStore } from "../utilities/StoreContext";
import { useNavigate, useParams } from "react-router";
import { useIDE } from "../utilities/IDEContext";
import { registerFileSystemOverlay } from "@codingame/monaco-vscode-files-service-override";
import TauriFileSystemProvider from "../utilities/TauriFileSystemProvider";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Checkbox,
  Divider,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Typography,
} from "@mui/joy";
import { ErrorIcon, useToast, WarningIcon } from "react-toast-plus";
import SwiftMenu from "../components/SwiftMenu";
import { restartServer } from "../utilities/lsp-client";
import BottomBar from "../components/Tiles/BottomBar";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { IStandaloneCodeEditor } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneCodeEditor";
import { MIN_DARWIN_SDK_VERSION, isSupportedSDKVersion } from "../utilities/constants";
import { writeFile } from "@tauri-apps/plugin-fs";
import { readTextFile } from "@tauri-apps/plugin-fs";
import UIBuilder from "../ui-builder/UIBuilder";
import {
  asArray,
  asString,
  configurationNames,
  isaOf,
  loadDocument,
  objectAt,
  objectName,
} from "../xcode-import/pbxproj";
import { defaultRemoteMacProfile, RemoteMacProfile } from "../utilities/remote-mac";

export interface IDEProps {}

type ProjectValidation =
  | "Valid"
  | "Invalid"
  | "UnsupportedFormatVersion"
  | "InvalidPackage"
  | "InvalidToolchain";

type ProjectInfo = {
  kind: string;
  root: string;
  entryPoint: string | null;
  capabilities: string[];
  targets: string[];
  schemes: string[];
  configurations: string[];
};

type WorkspaceTarget = {
  id: string;
  name: string;
  productType: string;
  configurations: string[];
};

async function loadWorkspaceTargets(info: ProjectInfo): Promise<WorkspaceTarget[]> {
  if (info.kind !== "xcodeProject" || !info.entryPoint) {
    return info.targets.map((name) => ({
      id: name,
      name,
      productType: "",
      configurations: info.configurations,
    }));
  }

  const contents = await readTextFile(`${info.entryPoint}/project.pbxproj`);
  const document = loadDocument(contents, info.entryPoint);
  return asArray(document.rootObject.targets)
    .map((id) => asString(id))
    .map((id) => {
      const target = objectAt(document, id);
      return {
        id,
        name: objectName(target),
        productType: asString(target.productType),
        configurations: configurationNames(document, asString(target.buildConfigurationList) || null),
      };
    })
    .filter((target) => isaOf(objectAt(document, target.id)) === "PBXNativeTarget" && target.name.length > 0);
}

let autoStartedLsp = "";

export default () => {
  const { storeInitialized, store } = useContext(StoreContext);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [navigatorCollapsed, setNavigatorCollapsed] = useState(false);
  const [saveFile, setSaveFile] = useState<(() => Promise<void>) | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [redo, setRedo] = useState<(() => void) | null>(null);
  const [theme] = useStore<"light" | "dark">("appearance/theme", "dark");
  const { path } = useParams<"path">();
  const {
    openFolderDialog,
    selectedToolchain,
    hasLimitedRam,
    initialized,
    ready,
    darwinSDKVersion,
    screenshot,
    setScreenshot,
    uiBuilderOpen,
    setUIBuilderOpen,
  } = useIDE();
  const [sourcekitStartup, setSourcekitStartup] = useStore<boolean | null>(
    "sourcekit/startup",
    null
  );
  const [hasIgnoredRam, setHasIgnoredRam] = useStore<boolean>(
    "has-ignored-ram",
    false
  );

  const [hasIgnoredDarwinSDK, setHasIgnoredDarwinSDK] = useStore<boolean>(
    "has-ignored-darwin-sdk",
    false
  );

  if (!path) {
    throw new Error("Path parameter is required in IDE component");
  }

  const [callbacks, setCallbacks] = useState<
    Record<string, (() => void) | (() => Promise<void>)>
  >({});
  const navigate = useNavigate();
  const [projectValidation, setProjectValidation] =
    useState<ProjectValidation | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [workspaceTargets, setWorkspaceTargets] = useState<WorkspaceTarget[]>([]);
  const workspaceSelectionKey = `workspace/${encodeURIComponent(path)}`;
  const [selectedTarget, setSelectedTarget] = useStore<string>(`${workspaceSelectionKey}/target`, "");
  const [selectedScheme, setSelectedScheme] = useStore<string>(`${workspaceSelectionKey}/scheme`, "");
  const [selectedConfiguration, setSelectedConfiguration] = useStore<string>(`${workspaceSelectionKey}/configuration`, "Debug");
  const [remoteMac, setRemoteMac] = useStore<RemoteMacProfile>(
    `${workspaceSelectionKey}/remote-mac`,
    defaultRemoteMacProfile
  );
  const [remoteMacDialogOpen, setRemoteMacDialogOpen] = useState(false);
  const [editor, setEditor] = useState<IStandaloneCodeEditor | null>(null);
  const { addToast } = useToast();

  useEffect(() => {
    if (ready === false && initialized) {
      console.log(
        "IDE not ready, returning to welcome page",
        ready,
        initialized
      );
      navigate("/");
    }
  }, [ready, initialized, navigate]);

  useEffect(() => {
    (async () => {
      if (!store || !storeInitialized || !path) return;
      await store.set("last-opened-project", encodeURIComponent(path!));
    })();
  }, [path, store, storeInitialized]);

  useEffect(() => {
    if (
      path === undefined ||
      path === null ||
      selectedToolchain === null ||
      !initialized
    )
      return;
    setProjectValidation(null);
    (async () => {
      if (path) {
        const toolchainPath = selectedToolchain?.path ?? "";
        const validation = await invoke<ProjectValidation>("validate_project", {
          projectPath: path,
          toolchainPath: toolchainPath,
        });
        if (validation) {
          setProjectValidation(validation);
        }
      }
    })();
  }, [path, selectedToolchain, initialized]);

  useEffect(() => {
    if (!path) return;
    invoke<ProjectInfo>("detect_project", { projectPath: path })
      .then(async (info) => {
        const targets = await loadWorkspaceTargets(info).catch((error) => {
          console.warn("Failed to parse workspace targets", error);
          return info.targets.map((name) => ({ id: name, name, productType: "", configurations: info.configurations }));
        });
        setProjectInfo(info);
        setWorkspaceTargets(targets);
        setSelectedTarget((current) => targets.some((target) => target.name === current) ? current : targets[0]?.name ?? "");
        setSelectedScheme((current) => info.schemes.includes(current) ? current : info.schemes[0] ?? "");
        setSelectedConfiguration((current) => {
          const configurations = targets[0]?.configurations.length ? targets[0].configurations : info.configurations;
          return configurations.includes(current) ? current : configurations[0] ?? "Debug";
        });
      })
      .catch((error) => console.warn("Failed to detect project type", error));
  }, [path]);

  const activeTarget = workspaceTargets.find((target) => target.name === selectedTarget) ?? null;
  const configurations = activeTarget?.configurations.length ? activeTarget.configurations : projectInfo?.configurations ?? [];

  useEffect(() => {
    if (openFiles.length === 0) {
      setOpenFile(null);
    }
    if (!openFiles.includes(openFile!)) {
      setOpenFile(openFiles[0]);
    }
  }, [openFiles]);

  useEffect(() => {
    let dispose = () => {};

    if (path) {
      const provider = new TauriFileSystemProvider(false);
      const overlayDisposable = registerFileSystemOverlay(1, provider);
      dispose = () => {
        overlayDisposable.dispose();
        provider.dispose();
      };
    }
    return () => {
      dispose();
    };
  }, [path]);

  useEffect(() => {
    let autoEnable = async () => {
      if (initialized && sourcekitStartup === null && hasLimitedRam === false) {
        setSourcekitStartup(true);
      }
    };
    autoEnable();
  }, [hasLimitedRam, initialized, sourcekitStartup]);

  useEffect(() => {
    if (!sourcekitStartup || selectedToolchain == null) return;
    requestAnimationFrame(async () => {
      try {
        if (autoStartedLsp === path) return;
        autoStartedLsp = path;
        await restartServer(path, selectedToolchain);
      } catch (e) {
        console.error("Failed to start SourceKit-LSP:", e);
        addToast.error(
          "Failed to start SourceKit-LSP (see devtools for details). Some language features may not be available."
        );
      }
    });
  }, [sourcekitStartup, path, selectedToolchain]);

  const openNewFile = useCallback((file: string) => {
    setOpenFile(file);
    setOpenFiles((oF) => {
      if (!oF.includes(file)) return [file, ...oF];
      return oF;
    });
  }, []);

  const selectFile = useCallback(async () => {
    const file = await openFileDialog({ multiple: false, directory: false });
    if (file) {
      openNewFile(file);
    }
  }, [openNewFile]);

  useEffect(() => {
    setCallbacks({
      save: saveFile ?? (async () => {}),
      openFolderDialog,
      newProject: () => navigate("/new"),
      welcomePage: () => navigate("/"),
      openFile: selectFile,
      undo: undo ?? (() => {}),
      redo: redo ?? (() => {}),
      toggleUIBuilder: () => setUIBuilderOpen((open) => !open),
      importXcodeProject: () => navigate("/import"),
    });
  }, [
    saveFile,
    openFolderDialog,
    navigate,
    selectFile,
    undo,
    redo,
    setUIBuilderOpen,
  ]);

  // the editor keeps most of the width; the optional panels split the rest
  const paneSizes = (() => {
    const editorShare = screenshot ? 50 : 80;
    const builderShare = Math.round(editorShare * 0.45);
    if (uiBuilderOpen && screenshot) return [20, editorShare - builderShare, builderShare, 30];
    if (uiBuilderOpen) return [20, editorShare - builderShare, builderShare];
    if (screenshot) return [20, editorShare, 30];
    return [20, editorShare];
  })();

  return (
    <div className="ide-container">
      <MenuBar callbacks={callbacks} editor={editor} />
      {projectInfo && (
        <div className="project-kind-bar">
          <span className="project-kind-label">Project</span>
          <span>{formatProjectKind(projectInfo.kind)}</span>
          {workspaceTargets.length > 0 && (
            <Select
              size="sm"
              value={selectedTarget}
              onChange={(_event, value) => {
                const nextTarget = value ?? "";
                setSelectedTarget(nextTarget);
                const configurations = workspaceTargets.find((target) => target.name === nextTarget)?.configurations;
                if (configurations?.length) setSelectedConfiguration(configurations[0]);
              }}
              aria-label="Build target"
            >
              {workspaceTargets.map((target) => <Option key={target.id} value={target.name}>{target.name}</Option>)}
            </Select>
          )}
          {projectInfo.schemes.length > 0 && (
            <Select
              size="sm"
              value={selectedScheme}
              onChange={(_event, value) => setSelectedScheme(value ?? "")}
              aria-label="Build scheme"
            >
              {projectInfo.schemes.map((scheme) => <Option key={scheme} value={scheme}>{scheme}</Option>)}
            </Select>
          )}
          {configurations.length > 0 && (
            <Select
              size="sm"
              value={selectedConfiguration}
              onChange={(_event, value) => setSelectedConfiguration(value ?? "Debug")}
              aria-label="Build configuration"
            >
              {configurations.map((configuration) => <Option key={configuration} value={configuration}>{configuration}</Option>)}
            </Select>
          )}
          {(projectInfo.kind === "xcodeProject" || projectInfo.kind === "xcodeWorkspace") && (
            <Button
              size="sm"
              variant={remoteMac.enabled ? "soft" : "plain"}
              onClick={() => setRemoteMacDialogOpen(true)}
            >
              {remoteMac.enabled ? `Remote: ${remoteMac.host}` : "Remote Mac"}
            </Button>
          )}
          {projectInfo.entryPoint && <span className="project-entry-point">{projectInfo.entryPoint}</span>}
        </div>
      )}
      <Splitter
        gutterTheme={theme === "dark" ? GutterTheme.Dark : GutterTheme.Light}
        direction={SplitDirection.Horizontal}
        initialSizes={paneSizes}
      >
        <Tile className="file-explorer-tile">
          <FileExplorer
            openFolder={path}
            setOpenFile={openNewFile}
            collapsed={navigatorCollapsed}
            onToggleCollapsed={() => setNavigatorCollapsed((value) => !value)}
            openInUIBuilder={(file) => {
              openNewFile(file);
              setUIBuilderOpen(true);
            }}
          />
        </Tile>
        <Splitter
          gutterTheme={theme === "dark" ? GutterTheme.Dark : GutterTheme.Light}
          direction={SplitDirection.Vertical}
          initialSizes={[70, 30]}
        >
          <Editor
            openFiles={openFiles}
            focusedFile={openFile}
            setSaveFile={setSaveFile}
            setUndo={setUndo}
            setRedo={setRedo}
            setOpenFiles={setOpenFiles}
            openNewFile={openNewFile}
            setEditorUpper={setEditor}
          />
          <BottomBar />
        </Splitter>
        {uiBuilderOpen && (
          <div className="ui-builder-tile">
            <UIBuilder
              projectPath={path}
              focusedFile={openFile}
              openNewFile={openNewFile}
              onClose={() => setUIBuilderOpen(false)}
            />
          </div>
        )}
        {screenshot && (
          <div className="screenshot-tile">
            <div>
              <Typography level="h3">Screenshot</Typography>
              <Button
                variant="outlined"
                onClick={async () => {
                  const blob = await (await fetch(screenshot)).blob();
                  const arrayBuffer = await blob.arrayBuffer();
                  const uint8Array = new Uint8Array(arrayBuffer);
                  const savePath = await save({
                    title: "Save Screenshot",
                    defaultPath: "screenshot.png",
                    filters: [
                      { name: "PNG Image", extensions: ["png"] },
                      { name: "All Files", extensions: ["*"] },
                    ],
                  });
                  if (!savePath) return;
                  await writeFile(savePath, uint8Array);
                  addToast.success("Saved screenshot to " + savePath);
                }}
              >
                Save
              </Button>
              <Button variant="outlined" onClick={() => setScreenshot(null)}>
                Close
              </Button>
            </div>
            <div className="screenshot-img-container">
              <img src={screenshot} alt="screenshot" />
            </div>
          </div>
        )}
      </Splitter>
      <Modal open={remoteMacDialogOpen} onClose={() => setRemoteMacDialogOpen(false)}>
        <ModalDialog sx={{ width: 480, maxWidth: "calc(100vw - 32px)" }}>
          <ModalClose />
          <Typography level="h3">Remote Mac Build</Typography>
          <Typography level="body-sm">
            Build this Xcode workspace over SSH. CrossCode uses your existing SSH key or agent; the project must already exist on the Mac.
          </Typography>
          <Checkbox
            label="Use this Mac for Xcode builds"
            checked={remoteMac.enabled}
            onChange={(event) => setRemoteMac((profile) => ({ ...profile, enabled: event.target.checked }))}
          />
          <Input
            placeholder="mac-mini.local"
            value={remoteMac.host}
            onChange={(event) => setRemoteMac((profile) => ({ ...profile, host: event.target.value }))}
            aria-label="Remote Mac host"
          />
          <div className="remote-mac-row">
            <Input
              placeholder="macOS user"
              value={remoteMac.user}
              onChange={(event) => setRemoteMac((profile) => ({ ...profile, user: event.target.value }))}
              aria-label="Remote Mac user"
            />
            <Input
              type="number"
              value={remoteMac.port}
              onChange={(event) => setRemoteMac((profile) => ({ ...profile, port: Number(event.target.value) || 22 }))}
              aria-label="SSH port"
              sx={{ width: 100 }}
            />
          </div>
          <Input
            placeholder="/Users/me/Projects/MyApp"
            value={remoteMac.projectPath}
            onChange={(event) => setRemoteMac((profile) => ({ ...profile, projectPath: event.target.value }))}
            aria-label="Project path on Remote Mac"
          />
          <div className="remote-mac-actions">
            <Button
              variant="outlined"
              onClick={() => {
                invoke("test_remote_mac", { remoteMac })
                  .then(() => addToast.success("Remote Mac is ready for Xcode builds."))
                  .catch((error) => addToast.error(String(error)));
              }}
              disabled={!remoteMac.host || !remoteMac.user || !remoteMac.projectPath}
            >
              Test Connection
            </Button>
            <Button onClick={() => setRemoteMacDialogOpen(false)}>Done</Button>
          </div>
        </ModalDialog>
      </Modal>
      {initialized &&
        selectedToolchain !== null &&
        projectValidation !== null &&
        projectValidation !== "Valid" && (
          <Modal
            open={true}
            onClose={() => {
              setProjectValidation(null);
            }}
          >
            <ModalDialog sx={{ maxWidth: "90vw" }}>
              <ModalClose />
              <div>
                <div style={{ display: "flex", gap: "var(--padding-sm)" }}>
                  <div style={{ width: "1.25rem" }}>
                    <ErrorIcon />
                  </div>
                  <Typography level="h3">Failed to load project</Typography>
                </div>
                <Typography level="body-lg">
                  {getValidationMsg(projectValidation)} Some features may not
                  work as expected.
                </Typography>
              </div>

              <Divider sx={{ mb: "var(--padding-xs)" }} />
              <div style={{ display: "flex", gap: "var(--padding-lg)" }}>
                {projectValidation === "InvalidToolchain" && <SwiftMenu />}
                {projectValidation !== "InvalidToolchain" && (
                  <>
                    <Button
                      onClick={() => {
                        navigate("/new");
                      }}
                    >
                      Create New
                    </Button>
                    <Button onClick={openFolderDialog}>
                      Open Other Project
                    </Button>
                    <Button
                      onClick={() => {
                        setProjectValidation(null);
                      }}
                      variant="outlined"
                    >
                      Ignore
                    </Button>
                  </>
                )}
              </div>
            </ModalDialog>
          </Modal>
        )}
      {initialized &&
        selectedToolchain !== null &&
        sourcekitStartup === null &&
        hasIgnoredRam === false &&
        hasLimitedRam && (
          <Modal
            open={true}
            onClose={() => {
              setHasIgnoredRam(true);
            }}
          >
            <ModalDialog sx={{ maxWidth: "90vw" }}>
              <ModalClose />
              <div>
                <div style={{ display: "flex", gap: "var(--padding-md)" }}>
                  <div style={{ width: "1.25rem" }}>
                    <WarningIcon />
                  </div>
                  <Typography level="h3">Limited Memory</Typography>
                </div>
                <Typography level="body-lg">
                  SourceKit-LSP is used to provide autocomplete, error
                  reporting, and other language features. However, it uses a
                  large amount of memory. Your device does not meet our
                  recommended memory requirements. You can choose to enable it
                  anyways, but it may cause crashes or instability.
                </Typography>
                <Typography
                  level="body-lg"
                  style={{ marginTop: "var(--padding-sm)" }}
                >
                  You can change this at any time in Edit {">"} Preferences{" "}
                  {">"} SourceKit LSP {">"} Auto-Launch SourceKit.
                </Typography>
                <Typography
                  level="body-lg"
                  style={{ marginTop: "var(--padding-sm)" }}
                >
                  You can also enable SourceKit temporarily with Build {">"}{" "}
                  Restart LSP.
                </Typography>
              </div>

              <Divider sx={{ mb: "var(--padding-xs)" }} />
              <div style={{ display: "flex", gap: "var(--padding-lg)" }}>
                <Button
                  onClick={() => {
                    setSourcekitStartup(false);
                    setHasIgnoredRam(true);
                  }}
                >
                  Keep disabled
                </Button>
                <Button
                  onClick={() => {
                    setSourcekitStartup(true);
                    setHasIgnoredRam(true);
                  }}
                  color="danger"
                  variant="outlined"
                >
                  Enable Anyway
                </Button>
              </div>
            </ModalDialog>
          </Modal>
        )}
      {initialized &&
        selectedToolchain !== null &&
        hasIgnoredDarwinSDK === false &&
        !isSupportedSDKVersion(darwinSDKVersion) && (
          <Modal
            open={true}
            onClose={() => {
              setHasIgnoredDarwinSDK(true);
            }}
          >
            <ModalDialog sx={{ maxWidth: "90vw" }}>
              <ModalClose />
              <div>
                <div style={{ display: "flex", gap: "var(--padding-md)" }}>
                  <div style={{ width: "1.25rem" }}>
                    <WarningIcon />
                  </div>
                  <Typography level="h3">Incompatible SDK Version</Typography>
                </div>
                <Typography level="body-lg">
                  This version of CrossCode is designed to work with Darwin SDK{" "}
                  {MIN_DARWIN_SDK_VERSION} or later, but you have version{" "}
                  {darwinSDKVersion} installed. Things may still work, but you
                  will miss out on newer features and may run into issues.
                </Typography>
              </div>

              <Divider sx={{ mb: "var(--padding-xs)" }} />
              <div style={{ display: "flex", gap: "var(--padding-lg)" }}>
                <Button
                  onClick={() => {
                    navigate("/#install-sdk");
                  }}
                >
                  Install Correct SDK
                </Button>
                <Button
                  onClick={() => {
                    setHasIgnoredDarwinSDK(true);
                  }}
                  variant="outlined"
                >
                  Ignore
                </Button>
              </div>
            </ModalDialog>
          </Modal>
        )}
    </div>
  );
};

function getValidationMsg(validation: ProjectValidation): string {
  switch (validation) {
    case "Invalid":
      return "This does not appear to be a valid CrossCode project.";
    case "InvalidPackage":
      return "SwiftPM was unable to parse your package. Please check your Package.swift file.";
    case "UnsupportedFormatVersion":
      return "This project uses an unsupported config format version. You may need to update CrossCode.";
    case "InvalidToolchain":
      return "Your Swift toolchain appears to be invalid.";
    default:
      return "";
  }
}

function formatProjectKind(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase());
}
