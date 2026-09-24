// Reads an existing SwiftUI view file back into a builder document.
//
// `codegen.ts` deliberately emits a small subset of SwiftUI, so the reader only
// has to understand that same subset: one view expression per node, a fixed set
// of modifiers and `@State` bindings. Anything outside that subset is reported
// as a warning instead of being silently dropped.

import { CATALOG } from "./catalog";
import { parseColor } from "./format";
import { DEFAULT_VIEW_NAME, DOCUMENT_VERSION, node } from "./types";
import type { Props, UIDocument, UINode } from "./types";

export type SwiftImport = {
  document: UIDocument;
  /** Notes about constructs the builder cannot represent. */
  warnings: string[];
};

type Closure = { label: string; body: string };
type Modifier = { name: string; args: string };
type Call = { name: string; args: string; closures: Closure[]; modifiers: Modifier[] };
type Arg = { label: string; value: string };
type Cursor = { text: string; index: number };

const FONT_NAMES = new Set([
  "largeTitle",
  "title",
  "title2",
  "title3",
  "headline",
  "subheadline",
  "body",
  "callout",
  "footnote",
  "caption",
  "caption2",
]);

const WEIGHT_NAMES = new Set([
  "ultraLight",
  "thin",
  "light",
  "regular",
  "medium",
  "semibold",
  "bold",
  "heavy",
  "black",
]);

const BUTTON_STYLES = new Set(["bordered", "borderedProminent", "plain"]);

const CONTROL_FLOW = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "guard",
  "let",
  "var",
  "return",
]);

/** Modifiers the generator emits that carry no builder state. */
const IGNORED_MODIFIERS = new Set(["aspectRatio", "textFieldStyle", "tag", "navigationTitle"]);

// ------------------------------------------------------------------- scanner --

/** Drops line and block comments, leaving string literals untouched. */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '"') {
      out += ch;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          out += inner + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += inner;
        index += 1;
        if (inner === '"') break;
      }
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function skipWhitespace(cursor: Cursor) {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index])) {
    cursor.index += 1;
  }
}

function readIdentifier(cursor: Cursor): string {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cursor.text.slice(cursor.index));
  if (!match) return "";
  cursor.index += match[0].length;
  return match[0];
}

/** Returns the text between a balanced `open`/`close` pair, strings included. */
function readGroup(cursor: Cursor, open: string, close: string): string {
  const { text } = cursor;
  if (text[cursor.index] !== open) return "";
  cursor.index += 1;
  const start = cursor.index;
  let depth = 1;
  while (cursor.index < text.length) {
    const ch = text[cursor.index];
    if (ch === '"') {
      cursor.index += 1;
      while (cursor.index < text.length) {
        const inner = text[cursor.index];
        if (inner === "\\") {
          cursor.index += 2;
          continue;
        }
        cursor.index += 1;
        if (inner === '"') break;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const inner = text.slice(start, cursor.index);
        cursor.index += 1;
        return inner;
      }
    }
    cursor.index += 1;
  }
  return text.slice(start);
}

/** One `Name(args) { … }` expression followed by its `.modifier(…)` chain. */
function parseCall(cursor: Cursor): Call | null {
  skipWhitespace(cursor);
  const name = readIdentifier(cursor);
  if (!name) return null;

  const call: Call = { name, args: "", closures: [], modifiers: [] };
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === "(") call.args = readGroup(cursor, "(", ")");

  for (;;) {
    skipWhitespace(cursor);
    if (cursor.text[cursor.index] === "{") {
      call.closures.push({ label: "", body: readGroup(cursor, "{", "}") });
      continue;
    }
    // Labelled trailing closure, e.g. `Button { … } label: { … }`.
    const save = cursor.index;
    const label = readIdentifier(cursor);
    if (label) {
      skipWhitespace(cursor);
      if (cursor.text[cursor.index] === ":" && cursor.text[cursor.index + 1] !== ":") {
        cursor.index += 1;
        skipWhitespace(cursor);
        if (cursor.text[cursor.index] === "{") {
          call.closures.push({ label, body: readGroup(cursor, "{", "}") });
          continue;
        }
      }
    }
    cursor.index = save;
    break;
  }

  for (;;) {
    skipWhitespace(cursor);
    if (cursor.text[cursor.index] !== ".") break;
    const save = cursor.index;
    cursor.index += 1;
    const modifierName = readIdentifier(cursor);
    if (!modifierName) {
      cursor.index = save;
      break;
    }
    let args = "";
    skipWhitespace(cursor);
    if (cursor.text[cursor.index] === "(") args = readGroup(cursor, "(", ")");
    call.modifiers.push({ name: modifierName, args });
  }

  return call;
}

/** Every view expression at the top level of a `ViewBuilder` body. */
function parseViewList(source: string, warnings: string[]): Call[] {
  const cursor: Cursor = { text: source, index: 0 };
  const calls: Call[] = [];
  while (cursor.index < cursor.text.length) {
    skipWhitespace(cursor);
    if (cursor.index >= cursor.text.length) break;
    const ch = cursor.text[cursor.index];
    if (ch === "}" || ch === ")") break;

    const call = parseCall(cursor);
    if (!call) {
      cursor.index += 1;
      continue;
    }

    if (CONTROL_FLOW.has(call.name)) {
      // `if`/`for`/… have no builder equivalent; consume the block and note it.
      warnings.push(`"${call.name}" blocks are not supported by the builder.`);
      while (cursor.index < cursor.text.length && cursor.text[cursor.index] !== "{") {
        cursor.index += 1;
      }
      if (cursor.text[cursor.index] === "{") readGroup(cursor, "{", "}");
      continue;
    }

    calls.push(call);
  }
  return calls;
}

// -------------------------------------------------------------------- helpers --

/** Splits on top-level commas, ignoring nesting and string literals. */
function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function argList(raw: string): Arg[] {
  return splitTopLevel(raw).map((part) => {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < part.length; i += 1) {
      const ch = part[i];
      if (inString) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === ":" && depth === 0) {
        return { label: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
      }
    }
    return { label: "", value: part.trim() };
  });
}

function argValue(args: Arg[], label: string): string {
  return args.find((arg) => arg.label === label)?.value ?? "";
}

/** First unlabelled argument, e.g. the `"Hello"` in `Text("Hello")`. */
function positional(args: Arg[]): string {
  return argValue(args, "");
}

function unquote(value: string, warnings?: string[]): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  if (inner.includes("\\(")) {
    warnings?.push(
      "String interpolation is not supported by the builder; the text is kept literally."
    );
  }
  return inner.replace(/\\(.)/g, (_match: string, ch: string) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch
  );
}

/** `.leading` / `leading` -> `leading`. */
function unDot(value: string): string {
  return value.trim().replace(/^\./, "");
}

/** `$isEnabled` -> `isEnabled`, but only for plain identifiers. */
function binding(value: string): string {
  const name = value.trim().replace(/^\$/, "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "";
}

function isNumber(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/** `.blue`, `#FF8800` or `Color(red:…)` to a value the XML inspector accepts. */
function colorValue(value: string): string | null {
  const trimmed = value.trim();
  const rgb = /^Color\(\s*red:\s*([\d.]+)\s*,\s*green:\s*([\d.]+)\s*,\s*blue:\s*([\d.]+)/.exec(
    trimmed
  );
  if (rgb) {
    const hex = (part: string) =>
      Math.max(0, Math.min(255, Math.round(Number(part) * 255)))
        .toString(16)
        .padStart(2, "0");
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
  }
  const parsed = parseColor(trimmed);
  if (!parsed) return null;
  return parsed.kind === "named" ? `.${parsed.name}` : trimmed.replace(/^#?/, "#");
}

function stringLiteral(value: string, warnings: string[], what: string): string | null {
  const parsed = unquote(value, warnings);
  if (parsed === null && value.trim().length > 0) {
    warnings.push(`${what} is not a plain string literal and was ignored.`);
  }
  return parsed;
}

// ---------------------------------------------------------------- modifiers --

function applyModifiers(props: Props, modifiers: Modifier[], warnings: string[]) {
  for (const modifier of modifiers) {
    const args = modifier.args.trim();
    switch (modifier.name) {
      case "font": {
        const name = unDot(args);
        if (FONT_NAMES.has(name)) props.font = `.${name}`;
        else warnings.push(`Font "${args || "(none)"}" is not supported by the builder.`);
        break;
      }
      case "fontWeight": {
        const name = unDot(args);
        if (WEIGHT_NAMES.has(name)) props.weight = `.${name}`;
        else warnings.push(`Font weight "${args || "(none)"}" is not supported by the builder.`);
        break;
      }
      case "foregroundStyle":
      case "foregroundColor": {
        const color = colorValue(args);
        if (color) props.foreground = color;
        else warnings.push(`Foreground colour "${args || "(none)"}" is not supported.`);
        break;
      }
      case "padding": {
        if (args.length === 0) props.padding = "8";
        else if (isNumber(args)) props.padding = args;
        else warnings.push(`Padding "${args}" is not supported; only a single value is.`);
        break;
      }
      case "frame": {
        const width = /width:\s*([\d.]+)/.exec(args);
        const height = /height:\s*([\d.]+)/.exec(args);
        if (width) props.frameWidth = width[1];
        if (height) props.frameHeight = height[1];
        break;
      }
      case "background": {
        const color = colorValue(args);
        if (color) props.background = color;
        else warnings.push(`Background "${args || "(none)"}" is not supported.`);
        break;
      }
      case "clipShape": {
        const radius = /RoundedRectangle\(cornerRadius:\s*([\d.]+)/.exec(args);
        if (radius) props.cornerRadius = radius[1];
        else warnings.push(`Clip shape "${args}" is not supported; only rounded rectangles are.`);
        break;
      }
      case "opacity": {
        if (isNumber(args)) props.opacity = args;
        else warnings.push(`Opacity "${args || "(none)"}" is not supported.`);
        break;
      }
      case "buttonStyle": {
        const name = unDot(args);
        if (BUTTON_STYLES.has(name)) props.style = name;
        else warnings.push(`Button style "${args || "(none)"}" is not supported.`);
        break;
      }
      case "resizable": {
        props.resizable = true;
        break;
      }
      default: {
        if (!IGNORED_MODIFIERS.has(modifier.name)) {
          warnings.push(`Modifier ".${modifier.name}" is not supported by the builder.`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------- mapping --

function childrenOf(call: Call, warnings: string[]): UINode[] {
  const closure = call.closures.find((candidate) => candidate.label === "");
  if (!closure) return [];
  return parseViewList(closure.body, warnings).map((child) => toNode(child, warnings));
}

/**
 * `navigationTitle` is generated on the (possibly Group-wrapped) child of a
 * `NavigationStack`, not on the stack itself, so it has to be collected from
 * there when reading a file back.
 */
function findNavigationTitle(calls: Call[], warnings: string[]): string | null {
  for (const child of calls) {
    const direct = child.modifiers.find((modifier) => modifier.name === "navigationTitle");
    if (direct) return stringLiteral(direct.args, warnings, "A navigation title");
    if (child.name === "Group") {
      const closure = child.closures.find((candidate) => candidate.label === "");
      if (closure) {
        const nested = findNavigationTitle(parseViewList(closure.body, warnings), warnings);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

function toNode(call: Call, warnings: string[]): UINode {
  const spec = CATALOG[call.name];
  if (!spec) {
    warnings.push(
      `"${call.name}" has no builder component; it is shown as a placeholder and will not be regenerated.`
    );
    return node(call.name, {}, []);
  }

  const args = argList(call.args);
  const props: Props = {};
  applyModifiers(props, call.modifiers, warnings);

  switch (call.name) {
    case "VStack":
    case "HStack": {
      const alignment = unDot(argValue(args, "alignment"));
      if (alignment) props.alignment = alignment;
      const spacing = argValue(args, "spacing");
      if (isNumber(spacing)) props.spacing = spacing.trim();
      break;
    }
    case "ScrollView": {
      props.axis = unDot(positional(args)) === "horizontal" ? "horizontal" : "vertical";
      break;
    }
    case "Section": {
      const header = stringLiteral(positional(args), warnings, "A Section header");
      if (header !== null) props.header = header;
      break;
    }
    case "NavigationStack": {
      const title = call.modifiers.find((modifier) => modifier.name === "navigationTitle");
      const own = title ? stringLiteral(title.args, warnings, "A navigation title") : null;
      if (own !== null) {
        props.title = own;
      } else {
        const closure = call.closures.find((candidate) => candidate.label === "");
        const childCalls = closure ? parseViewList(closure.body, warnings) : [];
        const inherited = findNavigationTitle(childCalls, warnings);
        if (inherited !== null) props.title = inherited;
      }
      break;
    }
    case "Text": {
      const text = stringLiteral(positional(args), warnings, "Text content");
      props.text = text ?? "";
      break;
    }
    case "Label": {
      const title = stringLiteral(positional(args), warnings, "A Label title");
      if (title !== null) props.title = title;
      const symbol = stringLiteral(argValue(args, "systemImage"), warnings, "A Label symbol");
      if (symbol !== null) props.systemImage = symbol;
      break;
    }
    case "Button": {
      const title = stringLiteral(positional(args), warnings, "A Button title");
      if (title !== null) props.title = title;
      const label = call.closures.find((candidate) => candidate.label === "label");
      if (label) {
        const inner = parseViewList(label.body, warnings)[0];
        if (inner && (inner.name === "Label" || inner.name === "Text")) {
          const innerArgs = argList(inner.args);
          const innerTitle = stringLiteral(positional(innerArgs), warnings, "A Button title");
          if (innerTitle !== null) props.title = innerTitle;
          if (inner.name === "Label") {
            const symbol = stringLiteral(
              argValue(innerArgs, "systemImage"),
              warnings,
              "A Button symbol"
            );
            if (symbol !== null) props.systemImage = symbol;
          }
          // Modifiers on the label view (font, padding, …) belong to the node.
          applyModifiers(props, inner.modifiers, warnings);
        }
      }
      break;
    }
    case "Toggle": {
      const title = stringLiteral(positional(args), warnings, "A Toggle title");
      if (title !== null) props.title = title;
      const isOn = binding(argValue(args, "isOn"));
      if (isOn) props.isOn = isOn;
      break;
    }
    case "TextField":
    case "SecureField": {
      const placeholder = stringLiteral(positional(args), warnings, "A placeholder");
      if (placeholder !== null) props.placeholder = placeholder;
      const text = binding(argValue(args, "text"));
      if (text) props.text = text;
      break;
    }
    case "Slider": {
      const value = binding(argValue(args, "value"));
      if (value) props.value = value;
      const range = /^(-?[\d.]+)\s*\.\.\.\s*(-?[\d.]+)$/.exec(argValue(args, "in").trim());
      if (range) {
        props.min = range[1];
        props.max = range[2];
      }
      break;
    }
    case "Stepper": {
      const title = stringLiteral(positional(args), warnings, "A Stepper title");
      if (title !== null) props.title = title;
      const value = binding(argValue(args, "value"));
      if (value) props.value = value;
      break;
    }
    case "Picker": {
      const title = stringLiteral(positional(args), warnings, "A Picker title");
      if (title !== null) props.title = title;
      const selection = binding(argValue(args, "selection"));
      if (selection) props.selection = selection;
      const closure = call.closures.find((candidate) => candidate.label === "");
      if (closure) {
        const options = parseViewList(closure.body, [])
          .filter((child) => child.name === "Text")
          .map((child) => unquote(positional(argList(child.args)), []) ?? "")
          .filter((option) => option.length > 0);
        if (options.length > 0) props.options = options.join(", ");
      }
      break;
    }
    case "DatePicker": {
      const title = stringLiteral(positional(args), warnings, "A DatePicker title");
      if (title !== null) props.title = title;
      const selection = binding(argValue(args, "selection"));
      if (selection) props.selection = selection;
      const components = unDot(argValue(args, "displayedComponents"));
      if (components) props.components = components;
      break;
    }
    case "ProgressView": {
      const title = stringLiteral(positional(args), warnings, "A ProgressView title");
      if (title !== null) props.title = title;
      const value = argValue(args, "value");
      if (isNumber(value)) props.value = value.trim();
      break;
    }
    case "Image": {
      const symbol = stringLiteral(argValue(args, "systemName"), warnings, "An SF Symbol name");
      const asset = stringLiteral(positional(args), warnings, "An asset name");
      if (symbol !== null) {
        props.source = "symbol";
        props.name = symbol;
      } else if (asset !== null) {
        props.source = "asset";
        props.name = asset;
      }
      break;
    }
    default:
      break;
  }

  return node(call.name, props, spec.container ? childrenOf(call, warnings) : []);
}

// -------------------------------------------------------------------- entry --

/** The name and `var body` of a SwiftUI view declaration, if there is one. */
function extractBody(source: string): { name: string; body: string } | null {
  const bodyMatch = /var\s+body\s*:\s*some\s+View\s*\{/.exec(source);
  if (!bodyMatch) return null;
  const cursor: Cursor = { text: source, index: bodyMatch.index + bodyMatch[0].length - 1 };
  const body = readGroup(cursor, "{", "}");
  const structMatch = /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*View\b/.exec(source);
  return { name: structMatch?.[1] ?? "", body };
}

/**
 * Parses SwiftUI source into a builder document, or null when the file holds no
 * `var body: some View` (an `App`, a model, a helper, …).
 */
export function parseSwiftDocument(
  source: string,
  options: { name?: string; includePreview?: boolean } = {}
): SwiftImport | null {
  const clean = stripComments(source);
  const extracted = extractBody(clean);
  if (!extracted) return null;

  const warnings: string[] = [];
  const roots = parseViewList(extracted.body, warnings).map((call) => toNode(call, warnings));
  if (roots.length === 0) return null;

  const viewName =
    extracted.name ||
    (options.name ? options.name.replace(/[^A-Za-z0-9_]/g, "") : "") ||
    DEFAULT_VIEW_NAME;

  const document: UIDocument = {
    version: DOCUMENT_VERSION,
    name: viewName,
    includePreview: options.includePreview ?? /#Preview\b/.test(clean),
    root: roots.length === 1 ? roots[0] : node("VStack", {}, roots),
  };

  return { document, warnings: dedupe(warnings) };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
