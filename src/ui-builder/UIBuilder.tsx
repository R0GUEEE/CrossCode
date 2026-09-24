// Visual SwiftUI builder: palette -> canvas -> inspector -> generated SwiftUI.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Button, Checkbox, Typography } from "@mui/joy";
import { useToast } from "react-toast-plus";
import {
  CATALOG,
  CATEGORY_ORDER,
  PALETTE,
  boxCss,
  defaultsFor,
  fieldsOf,
} from "./catalog";
import type { PropField } from "./catalog";
import { generateSwift } from "./codegen";
import { str, swiftIdentifier } from "./format";
import {
  DEFAULT_VIEW_NAME,
  DOCUMENT_VERSION,
  duplicateNode,
  findNode,
  findParent,
  insertNode,
  isDescendant,
  makeId,
  moveNode,
  node,
  removeNode,
  replaceNode,
  walk,
} from "./types";
import type { Props, UIDocument, UINode } from "./types";
import "./UIBuilder.css";

const PALETTE_MIME = "application/x-crosscode-ui-kind";
const NODE_MIME = "application/x-crosscode-ui-node";

export interface UIBuilderProps {
  projectPath: string;
  openNewFile: (file: string) => void;
  onClose: () => void;
}

// -------------------------------------------------------------- document io --

function starterDocument(): UIDocument {
  return {
    version: DOCUMENT_VERSION,
    name: DEFAULT_VIEW_NAME,
    includePreview: true,
    root: node("VStack", { alignment: "leading", spacing: "16", padding: "16" }, [
      node("Text", { text: "Hello, world!", font: ".largeTitle", weight: ".bold" }),
      node("Button", { title: "Tap me", style: "borderedProminent" }),
    ]),
  };
}

function normalizeNode(raw: unknown): UINode | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;

  const props: Props = {};
  if (record.props && typeof record.props === "object") {
    for (const [key, value] of Object.entries(record.props as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        props[key] = value;
      }
    }
  }

  const children: UINode[] = [];
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const normalized = normalizeNode(child);
      if (normalized) children.push(normalized);
    }
  }

  return {
    id: typeof record.id === "string" && record.id.length > 0 ? record.id : makeId(),
    kind: record.kind,
    props,
    children,
  };
}

function normalizeDocument(raw: unknown): UIDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const root = normalizeNode(record.root);
  if (!root) return null;
  return {
    version: DOCUMENT_VERSION,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : DEFAULT_VIEW_NAME,
    includePreview: record.includePreview !== false,
    root,
  };
}

/**
 * Where a drop lands: a container accepts children directly, dropping onto a
 * leaf inserts after it in the leaf's parent.
 */
function resolveDrop(current: UIDocument, hovered: UINode): { parent: UINode; index: number } {
  const spec = CATALOG[hovered.kind];
  const parent = spec?.container
    ? hovered
    : findParent(current.root, hovered.id) ?? current.root;
  const index = spec?.container
    ? parent.children.length
    : parent.children.findIndex((child) => child.id === hovered.id) + 1;
  return { parent, index };
}

// -------------------------------------------------------------- palette --

const Palette = ({ onAdd }: { onAdd: (kind: string) => void }) => (
  <div className="uib-palette">
    {CATEGORY_ORDER.map((category) => {
      const entries = PALETTE.filter((spec) => spec.category === category);
      if (entries.length === 0) return null;
      return (
        <div key={category} className="uib-palette-group">
          <div className="uib-group-title">{category}</div>
          {entries.map((spec) => (
            <div
              key={spec.kind}
              className="uib-palette-item"
              title={`${spec.label} — ${spec.summary}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PALETTE_MIME, spec.kind);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(spec.kind)}
            >
              {spec.label}
            </div>
          ))}
        </div>
      );
    })}
  </div>
);

// --------------------------------------------------------------- canvas --

interface NodeViewProps {
  node: UINode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDropOnNode: (event: DragEvent, target: UINode) => void;
}

const NodeView = ({ node: current, selectedId, onSelect, onDropOnNode }: NodeViewProps) => {
  const spec = CATALOG[current.kind];
  const children = current.children.map((child) => (
    <NodeView
      key={child.id}
      node={child}
      selectedId={selectedId}
      onSelect={onSelect}
      onDropOnNode={onDropOnNode}
    />
  ));

  if (!spec) {
    return (
      <div
        className="uib-node uib-node-unknown"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(current.id);
        }}
        onDragOver={(event) => event.preventDefault()}
      >
        Unknown component: {current.kind}
      </div>
    );
  }

  return (
    <div
      className={`uib-node${spec.container ? " uib-node-container" : ""}${
        selectedId === current.id ? " uib-node-selected" : ""
      }`}
      style={boxCss(current)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(current.id);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => onDropOnNode(event, current)}
    >
      <span className="uib-node-tag">{spec.label}</span>
      {spec.preview(current, children)}
    </div>
  );
};

const Canvas = ({
  doc,
  selectedId,
  onSelect,
  onDropOnNode,
  onDropOnRoot,
}: {
  doc: UIDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDropOnNode: (event: DragEvent, target: UINode) => void;
  onDropOnRoot: (event: DragEvent) => void;
}) => (
  <div className="uib-canvas" onClick={() => onSelect(doc.root.id)}>
    <div
      className="uib-device"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropOnRoot}
    >
      <div className="uib-statusbar">
        <span>9:41</span>
        <span>CrossCode preview</span>
      </div>
      <div className="uib-screen">
        <NodeView
          node={doc.root}
          selectedId={selectedId}
          onSelect={onSelect}
          onDropOnNode={onDropOnNode}
        />
      </div>
      <div className="uib-homebar" />
    </div>
  </div>
);

// ------------------------------------------------------------------ tree --

const TreeView = ({
  doc,
  selectedId,
  onSelect,
  onDelete,
  onDuplicate,
  onMove,
}: {
  doc: UIDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, delta: number) => void;
}) => (
  <div className="uib-tree">
    {walk(doc.root).map((item) => {
      const spec = CATALOG[item.kind];
      const depth = (() => {
        let level = 0;
        let parent = findParent(doc.root, item.id);
        while (parent) {
          level += 1;
          parent = findParent(doc.root, parent.id);
        }
        return level;
      })();
      return (
        <div
          key={item.id}
          className={`uib-tree-row${selectedId === item.id ? " uib-tree-row-selected" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => onSelect(item.id)}
        >
          <span className="uib-tree-label">
            {spec ? spec.label : item.kind}
            {spec && !spec.container && str(item.props.text) ? `: ${str(item.props.text)}` : ""}
          </span>
          <span className="uib-tree-actions">
            <button title="Move up" onClick={(event) => { event.stopPropagation(); onMove(item.id, -1); }}>
              ↑
            </button>
            <button title="Move down" onClick={(event) => { event.stopPropagation(); onMove(item.id, 1); }}>
              ↓
            </button>
            <button title="Duplicate" onClick={(event) => { event.stopPropagation(); onDuplicate(item.id); }}>
              ⧉
            </button>
            {item.id !== doc.root.id && (
              <button title="Delete" onClick={(event) => { event.stopPropagation(); onDelete(item.id); }}>
                ✕
              </button>
            )}
          </span>
        </div>
      );
    })}
  </div>
);

// ------------------------------------------------------------- inspector --

const FieldEditor = ({
  field,
  value,
  onChange,
}: {
  field: PropField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
}) => {
  if (field.type === "bool") {
    return (
      <div className="uib-field">
        <label>{field.label}</label>
        <Checkbox
          checked={value === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
      </div>
    );
  }

  if (field.type === "enum") {
    return (
      <div className="uib-field">
        <label>{field.label}</label>
        <select value={str(value)} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option === "" ? "(none)" : option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const isNumber = field.type === "number";
  const isState = field.type === "state";
  const text = typeof value === "number" ? value.toString() : str(value);
  const sanitized = isState ? swiftIdentifier(text) : "";
  const invalidState = isState && text.trim().length > 0 && sanitized !== text.trim();

  return (
    <div className="uib-field">
      <label>
        {field.label}
        {isState && <span className="uib-hint"> (name of the @State variable)</span>}
      </label>
      <input
        type={isNumber ? "number" : "text"}
        value={text}
        placeholder={"placeholder" in field ? field.placeholder : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {isState && (
        <div className={`uib-hint${invalidState ? " uib-hint-warn" : ""}`}>
          {invalidState
            ? `Not a valid name — the generated variable will be "${sanitized}"`
            : `Swift type: ${field.valueType}`}
        </div>
      )}
    </div>
  );
};

const Inspector = ({
  doc,
  selected,
  onPropChange,
  onDelete,
  onDuplicate,
  onMove,
  onSelect,
  onNameChange,
  onPreviewChange,
}: {
  doc: UIDocument;
  selected: UINode | null;
  onPropChange: (id: string, key: string, value: string | number | boolean) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  onSelect: (id: string) => void;
  onNameChange: (name: string) => void;
  onPreviewChange: (include: boolean) => void;
}) => {
  const spec = selected ? CATALOG[selected.kind] : null;
  const parent = selected ? findParent(doc.root, selected.id) : null;

  return (
    <div className="uib-inspector">
      <div className="uib-section">
        <div className="uib-group-title">Document</div>
        <div className="uib-field">
          <label>View name</label>
          <input
            type="text"
            value={doc.name}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <div className="uib-hint">Writes Sources/{swiftIdentifier(doc.name) || DEFAULT_VIEW_NAME}.swift</div>
        </div>
        <div className="uib-field">
          <label>#Preview block</label>
          <Checkbox
            checked={doc.includePreview}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onPreviewChange(event.target.checked)
            }
          />
        </div>
        <div className="uib-hint">
          #Preview needs a toolchain with macro support (reinstall the Darwin SDK if this fails).
        </div>
      </div>

      {selected && spec ? (
        <div className="uib-section">
          <div className="uib-group-title">{spec.label}</div>
          <div className="uib-node-actions">
            <Button size="sm" variant="soft" onClick={() => onMove(selected.id, -1)}>
              Up
            </Button>
            <Button size="sm" variant="soft" onClick={() => onMove(selected.id, 1)}>
              Down
            </Button>
            <Button size="sm" variant="soft" onClick={() => onDuplicate(selected.id)}>
              Duplicate
            </Button>
            {parent && (
              <Button size="sm" variant="soft" onClick={() => onSelect(parent.id)}>
                Parent
              </Button>
            )}
            {selected.id !== doc.root.id && (
              <Button size="sm" color="danger" variant="soft" onClick={() => onDelete(selected.id)}>
                Delete
              </Button>
            )}
          </div>
          {fieldsOf(selected).map((field) => (
            <FieldEditor
              key={field.key}
              field={field}
              value={selected.props[field.key]}
              onChange={(value) => onPropChange(selected.id, field.key, value)}
            />
          ))}
        </div>
      ) : (
        <div className="uib-section uib-hint">
          Nothing selected — click a view on the canvas or in the tree.
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------- main --

export default ({ projectPath, openNewFile, onClose }: UIBuilderProps) => {
  const [doc, setDoc] = useState<UIDocument>(starterDocument);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showCode, setShowCode] = useState(true);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const { addToast } = useToast();

  const docRef = useRef(doc);
  const historyRef = useRef<UIDocument[]>([]);
  const futureRef = useRef<UIDocument[]>([]);

  const documentPath = useMemo(
    () => `${projectPath.replace(/[\\/]+$/, "")}/.crosscode/ui-builder.json`,
    [projectPath]
  );
  const sourcesDirectory = useMemo(
    () => `${projectPath.replace(/[\\/]+$/, "")}/Sources`,
    [projectPath]
  );
  const viewName = swiftIdentifier(doc.name) || DEFAULT_VIEW_NAME;
  const swiftPath = `${sourcesDirectory}/${viewName}.swift`;
  const code = useMemo(() => generateSwift(doc), [doc]);

  const commit = useCallback((updater: (current: UIDocument) => UIDocument) => {
    const previous = docRef.current;
    const next = updater(previous);
    if (next === previous) return;
    docRef.current = next;
    historyRef.current.push(previous);
    if (historyRef.current.length > 100) historyRef.current.shift();
    futureRef.current = [];
    setUndoDepth(historyRef.current.length);
    setRedoDepth(0);
    setDoc(next);
  }, []);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    futureRef.current.push(docRef.current);
    docRef.current = previous;
    setDoc(previous);
    setUndoDepth(historyRef.current.length);
    setRedoDepth(futureRef.current.length);
  }, []);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(docRef.current);
    docRef.current = next;
    setDoc(next);
    setUndoDepth(historyRef.current.length);
    setRedoDepth(futureRef.current.length);
  }, []);

  // load the document that belongs to this project
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        if (await exists(documentPath)) {
          const parsed = normalizeDocument(JSON.parse(await readTextFile(documentPath)));
          if (parsed && !cancelled) {
            historyRef.current = [];
            futureRef.current = [];
            docRef.current = parsed;
            setDoc(parsed);
            setSelectedId(parsed.root.id);
            setUndoDepth(0);
            setRedoDepth(0);
          }
        } else {
          const fresh = starterDocument();
          docRef.current = fresh;
          setDoc(fresh);
          setSelectedId(fresh.root.id);
        }
      } catch (error) {
        console.warn("Failed to load the UI builder document", error);
        addToast.error("Failed to load the saved UI builder document");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentPath, addToast]);

  // autosave (debounced) so the layout survives a window reload
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(async () => {
      try {
        const directory = documentPath.substring(0, documentPath.lastIndexOf("/"));
        if (!(await exists(directory))) await mkdir(directory, { recursive: true });
        await writeTextFile(documentPath, JSON.stringify(doc, null, 2));
      } catch (error) {
        console.warn("Failed to save the UI builder document", error);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [doc, loaded, documentPath]);

  const addNode = useCallback(
    (kind: string, parentId?: string, index?: number) => {
      const created = node(kind, defaultsFor(kind));
      commit((current) => ({
        ...current,
        root: insertNode(current.root, parentId ?? current.root.id, created, index),
      }));
      setSelectedId(created.id);
    },
    [commit]
  );

  const deleteNode = useCallback(
    (id: string) => {
      commit((current) => ({ ...current, root: removeNode(current.root, id) }));
      setSelectedId((current) => (current === id ? docRef.current.root.id : current));
    },
    [commit]
  );

  const duplicate = useCallback(
    (id: string) => {
      const { root, newId } = duplicateNode(docRef.current.root, id);
      if (newId === id) return;
      commit(() => ({ ...docRef.current, root }));
      setSelectedId(newId);
    },
    [commit]
  );

  const move = useCallback(
    (id: string, delta: number) => {
      commit((current) => ({ ...current, root: moveNode(current.root, id, delta) }));
    },
    [commit]
  );

  const setProp = useCallback(
    (id: string, key: string, value: string | number | boolean) => {
      commit((current) => ({
        ...current,
        root: replaceNode(current.root, id, (item) => ({
          ...item,
          props: { ...item.props, [key]: value },
        })),
      }));
    },
    [commit]
  );

  const handleDropOnNode = useCallback(
    (event: DragEvent, hovered: UINode) => {
      event.preventDefault();
      event.stopPropagation();
      const kind = event.dataTransfer.getData(PALETTE_MIME);
      const movedId = event.dataTransfer.getData(NODE_MIME);
      if (!kind && !movedId) return;

      const current = docRef.current;
      const { parent, index } = resolveDrop(current, hovered);
      if (kind) {
        const created = node(kind, defaultsFor(kind));
        commit((d) => ({ ...d, root: insertNode(d.root, parent.id, created, index) }));
        setSelectedId(created.id);
        return;
      }
      const dragged = findNode(current.root, movedId);
      if (!dragged || dragged.id === hovered.id) return;
      if (isDescendant(dragged, parent.id)) return;
      const oldParent = findParent(current.root, movedId);
      const oldIndex = oldParent
        ? oldParent.children.findIndex((child) => child.id === movedId)
        : -1;
      let target = index;
      if (oldParent && oldParent.id === parent.id && oldIndex >= 0 && oldIndex < index) {
        target = index - 1;
      }
      const without = removeNode(current.root, movedId);
      commit((d) => ({
        ...d,
        root: insertNode(without, parent.id, dragged, target),
      }));
    },
    [commit]
  );

  const handleDropOnRoot = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(PALETTE_MIME);
      const movedId = event.dataTransfer.getData(NODE_MIME);
      if (!kind && !movedId) return;
      const current = docRef.current;
      if (kind) {
        const created = node(kind, defaultsFor(kind));
        commit((d) => ({
          ...d,
          root: insertNode(d.root, d.root.id, created, d.root.children.length),
        }));
        setSelectedId(created.id);
        return;
      }
      const dragged = findNode(current.root, movedId);
      if (!dragged || dragged.id === current.root.id) return;
      const without = removeNode(current.root, movedId);
      commit((d) => ({ ...d, root: insertNode(without, without.id, dragged) }));
    },
    [commit]
  );

  const saveSwift = useCallback(async () => {
    try {
      if (!(await exists(sourcesDirectory))) await mkdir(sourcesDirectory, { recursive: true });
      await writeTextFile(swiftPath, code);
      addToast.success(`Wrote ${swiftPath}`);
      return true;
    } catch (error) {
      addToast.error(`Failed to write ${swiftPath}: ${error}`);
      return false;
    }
  }, [addToast, code, sourcesDirectory, swiftPath]);

  const selected = selectedId ? findNode(doc.root, selectedId) : null;

  return (
    <div className="uib-root">
      <div className="uib-header">
        <Typography level="title-sm">UI Builder</Typography>
        <div className="uib-header-actions">
          <Button size="sm" variant="plain" disabled={undoDepth === 0} onClick={undo} title="Undo">
            ↶
          </Button>
          <Button size="sm" variant="plain" disabled={redoDepth === 0} onClick={redo} title="Redo">
            ↷
          </Button>
          <Button size="sm" variant="soft" onClick={() => void saveSwift()}>
            Save {viewName}.swift
          </Button>
          <Button
            size="sm"
            variant="soft"
            onClick={async () => {
              if (await saveSwift()) openNewFile(swiftPath);
            }}
          >
            Open in Editor
          </Button>
          <Button
            size="sm"
            variant="plain"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                addToast.success("Copied generated SwiftUI code");
              } catch {
                addToast.error("Clipboard is unavailable");
              }
            }}
          >
            Copy
          </Button>
          <Button size="sm" variant="plain" onClick={() => setShowCode((value) => !value)}>
            {showCode ? "Hide Code" : "Show Code"}
          </Button>
          <Button
            size="sm"
            variant="plain"
            onClick={() => {
              const fresh = starterDocument();
              docRef.current = fresh;
              historyRef.current = [];
              futureRef.current = [];
              setDoc(fresh);
              setSelectedId(fresh.root.id);
              setUndoDepth(0);
              setRedoDepth(0);
            }}
          >
            Reset
          </Button>
          <Button size="sm" variant="plain" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>

      <div className="uib-body">
        <div className="uib-column">
          <Palette onAdd={(kind) => addNode(kind)} />
        </div>
        <Canvas
          doc={doc}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDropOnNode={handleDropOnNode}
          onDropOnRoot={handleDropOnRoot}
        />
        <div className="uib-column uib-column-right">
          <Inspector
            doc={doc}
            selected={selected}
            onPropChange={setProp}
            onDelete={deleteNode}
            onDuplicate={duplicate}
            onMove={move}
            onSelect={setSelectedId}
            onNameChange={(name) => commit((current) => ({ ...current, name }))}
            onPreviewChange={(includePreview) =>
              commit((current) => ({ ...current, includePreview }))
            }
          />
          <div className="uib-tree-wrapper">
            <div className="uib-group-title">Structure</div>
            <TreeView
              doc={doc}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDelete={deleteNode}
              onDuplicate={duplicate}
              onMove={move}
            />
          </div>
        </div>
      </div>

      {showCode && (
        <div className="uib-code">
          <pre>{code}</pre>
        </div>
      )}
    </div>
  );
};
