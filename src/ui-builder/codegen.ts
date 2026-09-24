// Turns a builder document into SwiftUI source.
//
// The generator is intentionally dumb: one node -> one view expression, plus a
// fixed set of modifiers applied in a stable order, so that the output is
// predictable and easy to diff.

import { CATALOG, modifierLines, stateDeclarations } from "./catalog";
import {
  INDENT,
  appendModifier,
  indentLines,
  swiftIdentifier,
} from "./format";
import type { UIDocument, UINode } from "./types";

export type GenerateOptions = {
  /** Name of the generated struct, e.g. `ContentView`. */
  viewName: string;
  includePreview: boolean;
};

function renderNode(node: UINode): string[] {
  const spec = CATALOG[node.kind];
  if (!spec) {
    return [`// Unsupported component "${node.kind}"`];
  }

  const children = node.children
    .filter((c) => CATALOG[c.kind])
    .map((c) => renderNode(c));

  // Containers return their opening line(s) ending in "{"; the body and the
  // closing brace are added here so every container indents identically.
  let lines = spec.swift(node, children);
  if (spec.container) {
    if (lines.length === 0) {
      return [`// ${spec.label} produced no output`];
    }
    const body = spec.childModifiers
      ? spec.childModifiers(children, node)
      : children;
    lines = [...lines, ...body.flatMap((c) => indentLines(c, 1)), "}"];
  }

  for (const modifier of modifierLines(node)) {
    lines = appendModifier(lines, modifier);
  }
  return lines;
}

export function generateSwift(
  doc: UIDocument,
  options?: Partial<GenerateOptions>
): string {
  const viewName = swiftIdentifier(options?.viewName ?? doc.name) || "ContentView";
  const includePreview = options?.includePreview ?? doc.includePreview;

  const states = stateDeclarations(doc.root);
  const body = indentLines(renderNode(doc.root), 2);

  const lines: string[] = [];
  lines.push("import SwiftUI");
  lines.push("");
  lines.push(`struct ${viewName}: View {`);
  if (states.length > 0) {
    for (const declaration of states) {
      lines.push(`${INDENT}${declaration}`);
    }
    lines.push("");
  }
  lines.push(`${INDENT}var body: some View {`);
  if (body.length === 0) {
    lines.push(`${INDENT.repeat(2)}EmptyView()`);
  } else {
    lines.push(...body);
  }
  lines.push(`${INDENT}}`);
  lines.push("}");

  if (includePreview) {
    lines.push("");
    lines.push("#Preview {");
    lines.push(`${INDENT}${viewName}()`);
    lines.push("}");
  }

  return `${lines.join("\n")}\n`;
}
