// Tap actions for the visual SwiftUI builder.
//
// A node can carry one action, stored in three primitive props so the document
// stays plain JSON: `action` (what to do), `actionTarget` (the `@State`
// variable it changes) and `actionValue` (the value to assign, for `set`).
//
// Buttons render the action in their own trailing closure; every other view
// gets an `.onTapGesture { ... }` appended to its modifier chain. The state
// variables the action needs are declared by the generator (see
// `stateDeclarations`), so making a button flip a toggle is one dropdown.
//
// Pure module: no React, no catalog import, so it is unit tested directly.

import { str, swiftIdentifier, swiftString } from "./format";
import type { StateValueType } from "./state";
import type { UINode } from "./types";

export type ActionKind =
  | "none"
  | "toggle"
  | "increment"
  | "decrement"
  | "set"
  | "dismiss";

export const ACTION_OPTIONS: { value: ActionKind; label: string }[] = [
  { value: "none", label: "Nothing yet" },
  { value: "toggle", label: "Flip a toggle" },
  { value: "increment", label: "Add 1 to a number" },
  { value: "decrement", label: "Subtract 1 from a number" },
  { value: "set", label: "Assign a value" },
  { value: "dismiss", label: "Dismiss this view" },
];

export type NodeAction = {
  kind: ActionKind;
  /** Sanitised name of the state variable the action changes ("" when unused). */
  target: string;
  /** Raw text of the value a `set` action assigns. */
  value: string;
};

function isActionKind(value: string): value is ActionKind {
  return ACTION_OPTIONS.some((option) => option.value === value);
}

/** The action of a node, or null when it has none (or only an empty one). */
export function nodeAction(node: UINode): NodeAction | null {
  const kind = str(node.props.action);
  if (!isActionKind(kind) || kind === "none") return null;
  return {
    kind,
    target: swiftIdentifier(str(node.props.actionTarget)),
    value: str(node.props.actionValue),
  };
}

/** Whether the kind needs `actionTarget` filled in. */
export function needsTarget(kind: ActionKind): boolean {
  return kind === "toggle" || kind === "increment" || kind === "decrement" || kind === "set";
}

/** Whether the kind needs `actionValue` filled in. */
export function needsValue(kind: ActionKind): boolean {
  return kind === "set";
}

export type Literal = { swift: string; type: StateValueType };

/**
 * A Swift literal for what the user typed, so the builder can ask for a value
 * without asking for Swift syntax: `42` stays a number, `true` a Bool, `"a"`
 * stays as written and anything else is quoted.
 */
export function parseLiteral(raw: string): Literal | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text === "true" || text === "false") return { swift: text, type: "Bool" };
  if (/^-?\d+$/.test(text)) return { swift: text, type: "Int" };
  if (/^-?\d*\.\d+$/.test(text)) return { swift: text, type: "Double" };
  if (/^".*"$/.test(text)) return { swift: text, type: "String" };
  if (text === "Date()") return { swift: text, type: "Date" };
  return { swift: swiftString(text), type: "String" };
}

/**
 * Statements for the inside of a tap closure, not indented. An incomplete
 * action still produces valid Swift: it falls back to a comment.
 */
export function actionStatements(node: UINode): string[] {
  const action = nodeAction(node);
  if (!action) return [];
  if (action.kind === "dismiss") return ["dismiss()"];
  if (!action.target) return ["// TODO: name the state variable this changes"];

  switch (action.kind) {
    case "toggle":
      return [`${action.target}.toggle()`];
    case "increment":
      return [`${action.target} += 1`];
    case "decrement":
      return [`${action.target} -= 1`];
    case "set": {
      const literal = parseLiteral(action.value);
      if (!literal) return [`// TODO: give ${action.target} a value`];
      return [`${action.target} = ${literal.swift}`];
    }
    default:
      return [];
  }
}

export type ActionState = { name: string; type: StateValueType };

/**
 * The `@State` variables the action needs. `toggle` implies a Bool, the
 * counters an Int and `set` whatever the literal turned out to be.
 */
export function actionStateDeclarations(node: UINode): ActionState[] {
  const action = nodeAction(node);
  if (!action || !action.target) return [];
  if (action.kind === "toggle") return [{ name: action.target, type: "Bool" }];
  if (action.kind === "increment" || action.kind === "decrement") {
    return [{ name: action.target, type: "Int" }];
  }
  if (action.kind === "set") {
    const literal = parseLiteral(action.value);
    return [{ name: action.target, type: literal ? literal.type : "String" }];
  }
  return [];
}

/** Declaration a `dismiss` action needs (not a `@State`). */
export const DISMISS_DECLARATION = "@Environment(\\.dismiss) private var dismiss";

/** Whether the node's action calls `dismiss()`. */
export function usesDismiss(node: UINode): boolean {
  return nodeAction(node)?.kind === "dismiss";
}

/**
 * The `.onTapGesture` this node needs, or null. Buttons render their action in
 * their own closure and call this only for the body.
 */
export function tapGestureLines(node: UINode): { head: string; body: string[] } | null {
  const body = actionStatements(node);
  if (body.length === 0) return null;
  return { head: ".onTapGesture {", body };
}
