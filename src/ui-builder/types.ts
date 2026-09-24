// Data model of the visual SwiftUI builder.
//
// A document is a tree of nodes; every node maps to exactly one SwiftUI view
// (`kind`) plus a flat bag of props. Props are primitives so that a document
// can be persisted as JSON and edited by simple form fields.

export type Primitive = string | number | boolean;

export type Props = Record<string, Primitive>;

export type UINode = {
  id: string;
  kind: string;
  props: Props;
  children: UINode[];
};

export type UIDocument = {
  version: number;
  /** Name of the generated Swift `struct`, e.g. `ContentView`. */
  name: string;
  /** Emit a `#Preview` block (needs a macro-capable toolchain). */
  includePreview: boolean;
  root: UINode;
};

export const DOCUMENT_VERSION = 1;

export const DEFAULT_VIEW_NAME = "ContentView";

let nextId = 0;

export function makeId(): string {
  nextId += 1;
  return `n${nextId.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function node(kind: string, props: Props = {}, children: UINode[] = []): UINode {
  return { id: makeId(), kind, props, children };
}

/** Every node in the document, parents before children. */
export function walk(rootNode: UINode): UINode[] {
  const all: UINode[] = [];
  const visit = (n: UINode) => {
    all.push(n);
    n.children.forEach(visit);
  };
  visit(rootNode);
  return all;
}

export function findNode(rootNode: UINode, id: string): UINode | null {
  return walk(rootNode).find((n) => n.id === id) ?? null;
}

/** The node that contains `id`, or null for the root. */
export function findParent(rootNode: UINode, id: string): UINode | null {
  for (const n of walk(rootNode)) {
    if (n.children.some((c) => c.id === id)) return n;
  }
  return null;
}

export function isDescendant(ancestor: UINode, id: string): boolean {
  return walk(ancestor).some((n) => n.id === id);
}

/**
 * Immutably replace the node with `id`. `fn` returns the new node (or null to
 * delete it, which is only allowed for non-root nodes).
 */
export function replaceNode(
  rootNode: UINode,
  id: string,
  fn: (n: UINode) => UINode | null
): UINode {
  const visit = (n: UINode): UINode | null => {
    if (n.id === id) return fn(n);
    const children: UINode[] = [];
    for (const child of n.children) {
      const result = visit(child);
      if (result !== null) children.push(result);
    }
    return { ...n, children };
  };
  // fn returning null deletes a node; the root is not deletable
  return visit(rootNode) ?? rootNode;
}

export function insertNode(
  rootNode: UINode,
  parentId: string,
  newNode: UINode,
  index?: number
): UINode {
  return replaceNode(rootNode, parentId, (parent) => {
    const children = [...parent.children];
    const at = index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
    children.splice(at, 0, newNode);
    return { ...parent, children };
  });
}

export function removeNode(rootNode: UINode, id: string): UINode {
  const parent = findParent(rootNode, id);
  if (!parent) return rootNode;
  return replaceNode(rootNode, parent.id, (p) => ({
    ...p,
    children: p.children.filter((c) => c.id !== id),
  }));
}

export function moveNode(rootNode: UINode, id: string, delta: number): UINode {
  const parent = findParent(rootNode, id);
  if (!parent) return rootNode;
  const index = parent.children.findIndex((c) => c.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= parent.children.length) return rootNode;
  return replaceNode(rootNode, parent.id, (p) => {
    const children = [...p.children];
    const [moved] = children.splice(index, 1);
    children.splice(target, 0, moved);
    return { ...p, children };
  });
}

export function duplicateNode(rootNode: UINode, id: string): { root: UINode; newId: string } {
  const source = findNode(rootNode, id);
  if (!source) return { root: rootNode, newId: id };
  const copyOf = (n: UINode): UINode => ({
    ...n,
    id: makeId(),
    props: { ...n.props },
    children: n.children.map(copyOf),
  });
  const copy = copyOf(source);
  const parent = findParent(rootNode, id);
  const parentId = parent ? parent.id : rootNode.id;
  const index = parent ? parent.children.findIndex((c) => c.id === id) + 1 : 1;
  return { root: insertNode(rootNode, parentId, copy, index), newId: copy.id };
}
