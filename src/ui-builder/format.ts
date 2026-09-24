// Small pure helpers shared by the code generator and the component catalog.

import type { Primitive } from "./types";

export const INDENT = "    ";

export function indentLines(lines: string[], levels: number): string[] {
  const pad = INDENT.repeat(levels);
  return lines.map((l) => (l.length === 0 ? l : pad + l));
}

/**
 * Appends a modifier to a rendered view expression, following the usual Swift
 * style:
 *
 *     Text("Hi")            Button("Hi") {        Image("logo")
 *         .font(.title)         ...                   .resizable()
 *     }                         }                     .frame(width: 20)
 *                               .buttonStyle(.borderedProminent)
 *
 * i.e. a chain hangs one level below its base expression, while modifiers of a
 * trailing-closure block line up with the start of that block.
 */
export function appendModifier(lines: string[], modifier: string): string[] {
  const baseIndent = lines.length > 0 ? lines[0].length - lines[0].trimStart().length : 0;
  const last = lines.length > 0 ? lines[lines.length - 1] : "";
  const lastTrimmed = last.trimStart();

  let pad: number;
  if (lastTrimmed.startsWith(".")) {
    // continue an existing modifier chain
    pad = last.length - lastTrimmed.length;
  } else if (lines.length > 1 && lines[0].trimEnd().endsWith("{")) {
    // trailing-closure block: line up with the block itself
    pad = baseIndent;
  } else {
    pad = baseIndent + INDENT.length;
  }

  return [...lines, `${" ".repeat(pad)}${modifier}`];
}

/** Escape a Swift string literal body. */
export function swiftString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

const NAMED_COLORS = [
  "primary",
  "secondary",
  "red",
  "orange",
  "yellow",
  "green",
  "mint",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
  "brown",
  "white",
  "black",
  "gray",
  "clear",
];

export type ColorValue = { kind: "named"; name: string } | { kind: "rgb"; r: number; g: number; b: number };

/** Parses ".blue", "blue" or "#FF8800" into a colour value. */
export function parseColor(value: string): ColorValue | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const named = /^\.?([a-zA-Z]+)$/.exec(trimmed);
  if (named && NAMED_COLORS.includes(named[1].toLowerCase())) {
    return { kind: "named", name: named[1].toLowerCase() };
  }
  const hex = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!hex) return null;
  let digits = hex[1];
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return {
    kind: "rgb",
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  };
}

/**
 * `#RRGGBB` / `#RGB` / colour name to a `Color(...)` expression, so the builder
 * can offer hex colours without requiring a helper extension in the generated
 * project.
 */
export function swiftColor(value: string): string | null {
  const parsed = parseColor(value);
  if (!parsed) return null;
  if (parsed.kind === "named") return `.${parsed.name}`;
  const fmt = (v: number) => Number((v / 255).toFixed(3)).toString();
  return `Color(red: ${fmt(parsed.r)}, green: ${fmt(parsed.g)}, blue: ${fmt(parsed.b)})`;
}

/** Sanitised Swift identifier, or "" when nothing usable is left. */
export function swiftIdentifier(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_]/g, "");
  if (cleaned.length === 0) return "";
  return /^[0-9]/.test(cleaned) ? `v${cleaned}` : cleaned;
}

export function str(value: Primitive | undefined): string {
  return typeof value === "string" ? value : "";
}

export function bool(value: Primitive | undefined): boolean {
  return value === true || value === "true";
}

/** Parses a numeric prop; empty string / garbage means "not set". */
export function num(value: Primitive | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `"a, b,c"` -> `["a", "b", "c"]`, dropping empty entries. */
export function csv(value: Primitive | undefined): string[] {
  return str(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Swift number literal: keeps integers integral, e.g. 2 -> "2", 2.5 -> "2.5". */
export function swiftNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toString();
}
