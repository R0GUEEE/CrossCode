import { describe, expect, test } from "bun:test";
import {
  DISMISS_DECLARATION,
  actionStateDeclarations,
  actionStatements,
  needsTarget,
  needsValue,
  nodeAction,
  parseLiteral,
  tapGestureLines,
  usesDismiss,
} from "./actions";
import { node } from "./types";

describe("nodeAction", () => {
  test("is null without an action and for the 'none' placeholder", () => {
    expect(nodeAction(node("Button", {}))).toBeNull();
    expect(nodeAction(node("Button", { action: "none" }))).toBeNull();
    expect(nodeAction(node("Button", { action: "nonsense" }))).toBeNull();
  });

  test("sanitises the target name", () => {
    const action = nodeAction(node("Button", { action: "toggle", actionTarget: "is Enabled!" }));
    expect(action?.kind).toBe("toggle");
    expect(action?.target).toBe("isEnabled");
  });

  test("knows which kinds need a target or a value", () => {
    expect(needsTarget("toggle")).toBe(true);
    expect(needsTarget("set")).toBe(true);
    expect(needsTarget("dismiss")).toBe(false);
    expect(needsValue("set")).toBe(true);
    expect(needsValue("toggle")).toBe(false);
  });
});

describe("parseLiteral", () => {
  test("keeps numbers, booleans and quoted strings as Swift literals", () => {
    expect(parseLiteral("42")).toEqual({ swift: "42", type: "Int" });
    expect(parseLiteral("-3")).toEqual({ swift: "-3", type: "Int" });
    expect(parseLiteral("2.5")).toEqual({ swift: "2.5", type: "Double" });
    expect(parseLiteral("true")).toEqual({ swift: "true", type: "Bool" });
    expect(parseLiteral('"Alex"')).toEqual({ swift: '"Alex"', type: "String" });
  });

  test("quotes anything else, and escapes it", () => {
    expect(parseLiteral("Alex")).toEqual({ swift: '"Alex"', type: "String" });
    expect(parseLiteral('say "hi"')).toEqual({ swift: '"say \\"hi\\""', type: "String" });
    expect(parseLiteral("   ")).toBeNull();
  });
});

describe("actionStatements", () => {
  test("renders each action kind", () => {
    expect(actionStatements(node("Button", { action: "toggle", actionTarget: "isOn" }))).toEqual([
      "isOn.toggle()",
    ]);
    expect(actionStatements(node("Button", { action: "increment", actionTarget: "count" }))).toEqual([
      "count += 1",
    ]);
    expect(actionStatements(node("Button", { action: "decrement", actionTarget: "count" }))).toEqual([
      "count -= 1",
    ]);
    expect(actionStatements(node("Button", { action: "set", actionTarget: "name", actionValue: "Alex" }))).toEqual([
      'name = "Alex"',
    ]);
    expect(actionStatements(node("Button", { action: "dismiss" }))).toEqual(["dismiss()"]);
  });

  test("stays valid Swift when the action is not finished", () => {
    expect(actionStatements(node("Button", { action: "toggle" }))).toEqual([
      "// TODO: name the state variable this changes",
    ]);
    expect(actionStatements(node("Button", { action: "set", actionTarget: "name" }))).toEqual([
      "// TODO: give name a value",
    ]);
    expect(actionStatements(node("Button", {}))).toEqual([]);
  });
});

describe("action state", () => {
  test("infers the type of the variable an action needs", () => {
    expect(actionStateDeclarations(node("Button", { action: "toggle", actionTarget: "isOn" }))).toEqual([
      { name: "isOn", type: "Bool" },
    ]);
    expect(actionStateDeclarations(node("Button", { action: "increment", actionTarget: "count" }))).toEqual([
      { name: "count", type: "Int" },
    ]);
    expect(
      actionStateDeclarations(node("Button", { action: "set", actionTarget: "ratio", actionValue: "0.5" }))
    ).toEqual([{ name: "ratio", type: "Double" }]);
    expect(
      actionStateDeclarations(node("Button", { action: "set", actionTarget: "name", actionValue: "Alex" }))
    ).toEqual([{ name: "name", type: "String" }]);
  });

  test("needs nothing without a target or for a dismiss", () => {
    expect(actionStateDeclarations(node("Button", { action: "toggle" }))).toEqual([]);
    expect(actionStateDeclarations(node("Button", { action: "dismiss" }))).toEqual([]);
    expect(usesDismiss(node("Button", { action: "dismiss" }))).toBe(true);
    expect(usesDismiss(node("Button", { action: "toggle", actionTarget: "x" }))).toBe(false);
    expect(DISMISS_DECLARATION).toBe("@Environment(\\.dismiss) private var dismiss");
  });
});

describe("tapGestureLines", () => {
  test("is null when there is nothing to run", () => {
    expect(tapGestureLines(node("Text", { text: "Hi" }))).toBeNull();
  });

  test("opens a closure with the action body", () => {
    expect(tapGestureLines(node("Text", { text: "Hi", action: "toggle", actionTarget: "hi" }))).toEqual({
      head: ".onTapGesture {",
      body: ["hi.toggle()"],
    });
  });
});
