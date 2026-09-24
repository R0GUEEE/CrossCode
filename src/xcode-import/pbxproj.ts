// Parser for Xcode's `project.pbxproj` files.
//
// The file is an OpenStep property list: dictionaries, arrays, quoted strings
// and bare tokens, with `/* ... */` comments everywhere. Xcode writes the same
// syntax for every project version, so a small hand-written parser is enough —
// no dependency, and it keeps the importer working on all platforms.

export type PbxValue = string | PbxValue[] | { [key: string]: PbxValue };
export type PbxDict = { [key: string]: PbxValue };
export type PbxArray = PbxValue[];

export class PbxParseError extends Error {}

type Parser = {
  text: string;
  pos: number;
};

function skipTrivia(parser: Parser): void {
  const { text } = parser;
  while (parser.pos < text.length) {
    const char = text[parser.pos];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      parser.pos += 1;
      continue;
    }
    if (char === "/" && text[parser.pos + 1] === "/") {
      const end = text.indexOf("\n", parser.pos);
      parser.pos = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "/" && text[parser.pos + 1] === "*") {
      const end = text.indexOf("*/", parser.pos + 2);
      parser.pos = end === -1 ? text.length : end + 2;
      continue;
    }
    return;
  }
}

function isBareTerminator(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "{" ||
    char === "}" ||
    char === "(" ||
    char === ")" ||
    char === "=" ||
    char === ";" ||
    char === ","
  );
}

function parseQuotedString(parser: Parser): string {
  const { text } = parser;
  parser.pos += 1; // opening quote
  let result = "";
  while (parser.pos < text.length) {
    const char = text[parser.pos];
    if (char === "\\") {
      const next = text[parser.pos + 1];
      if (next === "n") result += "\n";
      else if (next === "t") result += "\t";
      else if (next === "r") result += "\r";
      else if (next === "u") {
        const hex = text.slice(parser.pos + 2, parser.pos + 6);
        const code = parseInt(hex, 16);
        if (!Number.isNaN(code)) {
          result += String.fromCharCode(code);
          parser.pos += 6;
          continue;
        }
        result += next;
      } else if (next === undefined) {
        result += "\\";
      } else {
        result += next;
      }
      parser.pos += 2;
      continue;
    }
    if (char === '"') {
      parser.pos += 1;
      return result;
    }
    result += char;
    parser.pos += 1;
  }
  throw new PbxParseError("unterminated string");
}

function parseBareToken(parser: Parser): string {
  const { text } = parser;
  const start = parser.pos;
  while (parser.pos < text.length) {
    const char = text[parser.pos];
    if (isBareTerminator(char)) break;
    // a slash only ends a token when it starts a comment: paths stay intact
    if (char === "/" && (text[parser.pos + 1] === "/" || text[parser.pos + 1] === "*")) break;
    parser.pos += 1;
  }
  return text.slice(start, parser.pos);
}

/** `<0a1b2c>` data values are kept verbatim. */
function parseData(parser: Parser): string {
  const { text } = parser;
  const start = parser.pos;
  while (parser.pos < text.length && text[parser.pos] !== ">") {
    parser.pos += 1;
  }
  parser.pos += 1;
  return text.slice(start, parser.pos);
}

function parseValue(parser: Parser): PbxValue {
  skipTrivia(parser);
  const char = parser.text[parser.pos];
  if (char === "{") return parseDictionary(parser);
  if (char === "(") return parseArray(parser);
  if (char === '"') return parseQuotedString(parser);
  if (char === "<") return parseData(parser);
  return parseBareToken(parser);
}

function parseDictionary(parser: Parser): PbxDict {
  parser.pos += 1; // {
  const result: PbxDict = {};
  for (;;) {
    skipTrivia(parser);
    if (parser.pos >= parser.text.length) {
      throw new PbxParseError("unterminated dictionary");
    }
    if (parser.text[parser.pos] === "}") {
      parser.pos += 1;
      return result;
    }
    const key =
      parser.text[parser.pos] === '"'
        ? parseQuotedString(parser)
        : parseBareToken(parser);
    if (key.length === 0) {
      throw new PbxParseError(
        `unexpected character '${parser.text[parser.pos]}' near ${JSON.stringify(
          parser.text.slice(Math.max(0, parser.pos - 40), parser.pos + 40)
        )}`
      );
    }
    skipTrivia(parser);
    if (parser.text[parser.pos] !== "=") {
      throw new PbxParseError(`expected '=' after key '${key}'`);
    }
    parser.pos += 1;
    result[key] = parseValue(parser);
    skipTrivia(parser);
    if (parser.text[parser.pos] === ";") parser.pos += 1;
  }
}

function parseArray(parser: Parser): PbxArray {
  parser.pos += 1; // (
  const result: PbxArray = [];
  for (;;) {
    skipTrivia(parser);
    if (parser.pos >= parser.text.length) {
      throw new PbxParseError("unterminated array");
    }
    if (parser.text[parser.pos] === ")") {
      parser.pos += 1;
      return result;
    }
    result.push(parseValue(parser));
    skipTrivia(parser);
    if (parser.text[parser.pos] === ",") parser.pos += 1;
  }
}

/** Parses a whole pbxproj (or a standalone plist) into plain JS values. */
export function parsePbx(text: string): PbxDict {
  const parser: Parser = { text, pos: 0 };
  const value = parseValue(parser);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PbxParseError("expected a dictionary at the top level");
  }
  return value;
}

// ------------------------------------------------------------------ access --

export function asDict(value: PbxValue | undefined): PbxDict {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asArray(value: PbxValue | undefined): PbxArray {
  return Array.isArray(value) ? value : [];
}

export function asString(value: PbxValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

export type PbxObjects = Record<string, PbxDict>;

export interface PbxDocument {
  objects: PbxObjects;
  rootObjectId: string;
  rootObject: PbxDict;
  /** Absolute path of the directory containing the `.xcodeproj`. */
  projectDirectory: string;
}

export function loadDocument(text: string, projectDirectory: string): PbxDocument {
  const root = parsePbx(text);
  const objects = asDict(root.objects) as PbxObjects;
  const rootObjectId = asString(root.rootObject);
  const rootObject = asDict(objects[rootObjectId]);
  if (Object.keys(objects).length === 0 || Object.keys(rootObject).length === 0) {
    throw new PbxParseError("project.pbxproj has no objects/rootObject");
  }
  return { objects, rootObjectId, rootObject, projectDirectory };
}

export function objectAt(document: PbxDocument, id: string): PbxDict {
  return asDict(document.objects[id]);
}

export function isaOf(object: PbxDict): string {
  return asString(object.isa);
}

/** `name` is the display name; group entries may only carry `path`. */
export function objectName(object: PbxDict): string {
  return asString(object.name) || asString(object.path);
}

/**
 * Files a build phase compiles/copies, resolved through `PBXBuildFile` entries.
 * Variant groups (localised resources) are flattened into their children.
 */
export function buildPhaseFiles(
  document: PbxDocument,
  phaseId: string
): { fileRefId: string; name: string }[] {
  const phase = objectAt(document, phaseId);
  const result: { fileRefId: string; name: string }[] = [];
  for (const entry of asArray(phase.files)) {
    const buildFile = objectAt(document, asString(entry));
    const fileRefId = asString(buildFile.fileRef);
    if (!fileRefId) continue;
    const fileRef = objectAt(document, fileRefId);
    if (isaOf(fileRef) === "PBXVariantGroup") {
      for (const child of asArray(fileRef.children)) {
        const childId = asString(child);
        result.push({ fileRefId: childId, name: objectName(objectAt(document, childId)) });
      }
      continue;
    }
    result.push({ fileRefId, name: objectName(fileRef) });
  }
  return result;
}

/** Phases declared by a target, keyed by isa. */
export function targetBuildPhases(document: PbxDocument, targetId: string): PbxDict[] {
  return asArray(objectAt(document, targetId).buildPhases).map((id) => objectAt(document, asString(id)));
}

export function configurationNames(document: PbxDocument, listId: string | null): string[] {
  if (!listId) return [];
  const list = objectAt(document, listId);
  return asArray(list.buildConfigurations).map((id) =>
    asString(objectAt(document, asString(id)).name)
  );
}

/**
 * Build settings of one configuration, merged onto `base` so project level
 * settings can be overridden by a target.
 */
export function resolveBuildSettings(
  document: PbxDocument,
  listId: string | null,
  configurationName: string,
  base: Record<string, string> = {}
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  if (!listId) return merged;
  const list = objectAt(document, listId);
  const ids = asArray(list.buildConfigurations).map((id) => asString(id));
  const preferred =
    ids.find((id) => asString(objectAt(document, id).name) === configurationName) ?? ids[0];
  if (!preferred) return merged;

  const settings = asDict(objectAt(document, preferred).buildSettings);
  for (const [key, value] of Object.entries(settings)) {
    // list settings (OTHER_SWIFT_FLAGS, ...) are joined the way Xcode renders them
    merged[key] = Array.isArray(value)
      ? value.map((entry) => asString(entry)).join(" ")
      : asString(value);
  }
  return merged;
}
