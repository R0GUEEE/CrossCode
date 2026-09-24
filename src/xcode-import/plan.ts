// Turns an Xcode project into a CrossCode (SwiftPM) package.
//
// The import is "in place": sources stay where they are and the generated
// `Package.swift` points at them with `path:`/`exclude:`, so the project can
// keep being edited in Xcode. Only the CrossCode specific files are added
// (`Package.swift`, `crosscode.toml`, an Info.plist when missing), plus copies
// of plain resources, because CrossCode packages `<package>/Resources` into the
// .app.
//
// The planner is pure: every filesystem read goes through the optional
// `readFile` / `listDirectory` callbacks, which keeps it unit testable.

import {
  asArray,
  asDict,
  asString,
  buildPhaseFiles,
  isaOf,
  loadDocument,
  objectAt,
  objectName,
  resolveBuildSettings,
  type PbxDict,
  type PbxDocument,
} from "./pbxproj";

export type ImportTargetKind = "app" | "framework" | "extension" | "test" | "other";

export interface ImportTarget {
  id: string;
  /** Xcode target name. */
  name: string;
  /** Sanitised name used as the SwiftPM target. */
  swiftName: string;
  productType: string;
  kind: ImportTargetKind;
  swiftPackageTargetType: "executable" | "regular" | null;
  productName: string;
  /** Package relative directory holding the sources, if they could be located. */
  sourceDirectory: string | null;
  /** SwiftPM `path:` (equals sourceDirectory for converted targets). */
  path: string | null;
  excludes: string[];
  /** Package relative source files that were discovered. */
  sources: string[];
  /** Package relative resources copied into `Resources/`. */
  resources: string[];
  /** Names of the other targets of this project it depends on. */
  dependencies: string[];
  /** `XCSwiftPackageProductDependency` entries: product name plus package identity. */
  packageProducts: { productName: string; package: string | null }[];
  bundleId: string;
  deploymentTarget: string;
  settings: Record<string, string>;
  skippedReason: string | null;
}

export interface ImportPackageDependency {
  /** Package identity (the directory name for local packages). */
  identity: string;
  kind: "local" | "remote";
  /** Relative path (local) or repository URL (remote). */
  location: string;
  /** Recognised version requirement for remote packages. */
  requirement: string | null;
}

export interface ImportPlan {
  /** Directory that receives Package.swift (the xcodeproj's parent). */
  packageRoot: string;
  packageName: string;
  productName: string;
  targets: ImportTarget[];
  warnings: string[];
  /** Files to create, keyed by package relative path. */
  files: { path: string; contents: string }[];
  /** Resource copies: absolute source -> package relative destination. */
  copies: { from: string; to: string }[];
  packages: ImportPackageDependency[];
  /** Build settings of the configuration the plan was derived from. */
  settings: Record<string, string>;
  configuration: string;
  infoPlistSource: string | null;
}

export interface PlanOptions {
  /** Configuration read from the project (defaults to Release). */
  configuration?: string;
  /** Directory the generated files go into (defaults to the xcodeproj's parent). */
  packageRoot?: string;
  /** Name of the generated package (defaults to the xcodeproj name). */
  packageName?: string;
  readFile?: (absolutePath: string) => string | null;
  /** Returns the absolute paths of a directory's entries. */
  listDirectory?: (absolutePath: string) => string[];
}

export class ImportError extends Error {}

// ----------------------------------------------------------------- helpers --

/** Assets/storyboards need Xcode's compilers, which do not exist on Linux. */
const UNSUPPORTED_EXTENSIONS = new Set([
  "xcassets",
  "storyboard",
  "xib",
  "xcdatamodeld",
  "xcmappingmodel",
  "intentdefinition",
  "metal",
]);

const RESOURCE_EXTENSIONS = new Set([
  "strings",
  "stringsdict",
  "plist",
  "json",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "pdf",
  "heic",
  "webp",
  "mp3",
  "m4a",
  "caf",
  "wav",
  "mov",
  "mp4",
  "txt",
  "html",
  "css",
  "js",
  "ttf",
  "otf",
  "csv",
  "xml",
  "geojson",
  "usdz",
  "scn",
]);

const SOURCE_EXTENSIONS = new Set(["swift", "m", "mm", "c", "cc", "cpp", "h", "hpp", "s", "metal"]);

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function segments(path: string): string[] {
  return normalize(path).split("/").filter((part) => part.length > 0);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(normalize(path));
}

/** Joins a path without dropping a leading "/" or "C:/". */
function joinPath(base: string, child: string): string {
  const normalizedBase = normalize(base);
  if (child.length === 0) return normalizedBase;
  if (isAbsolutePath(child)) return normalize(child);
  if (normalizedBase.length === 0) return child;
  return `${normalizedBase}/${child}`;
}

function dirOf(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  if (index < 0) return "/";
  const directory = normalized.slice(0, index);
  if (directory.length === 0) return "/";
  if (/^[A-Za-z]:$/.test(directory)) return `${directory}/`;
  return directory;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Drops excludes that are already covered by an excluded parent directory. */
export function pruneExcludes(excludes: string[]): string[] {
  const sorted = [...new Set(excludes)].sort(
    (a, b) => segments(a).length - segments(b).length || a.localeCompare(b)
  );
  const kept: string[] = [];
  for (const candidate of sorted) {
    if (kept.some((parent) => candidate.startsWith(`${parent}/`))) continue;
    kept.push(candidate);
  }
  return kept.sort();
}

function isUnder(directory: string, path: string): boolean {
  if (directory === "" || directory === ".") return true;
  return path === directory || path.startsWith(`${directory}/`);
}

function relativeTo(root: string, path: string): string | null {
  const rootParts = segments(root);
  const pathParts = segments(path);
  if (pathParts.length < rootParts.length) return null;
  for (let index = 0; index < rootParts.length; index += 1) {
    if (rootParts[index].toLowerCase() !== pathParts[index].toLowerCase()) return null;
  }
  return pathParts.slice(rootParts.length).join("/");
}

/** "Food Truck" -> "FoodTruck"; used for package, product and target names. */
export function swiftIdentifier(raw: string): string {
  const words = raw.split(/[^A-Za-z0-9_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return "Package";
  const joined = words.join("");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = segments(dirOf(paths[0]));
  for (const path of paths.slice(1)) {
    const parts = segments(dirOf(path));
    let length = 0;
    while (
      length < prefix.length &&
      length < parts.length &&
      prefix[length].toLowerCase() === parts[length].toLowerCase()
    ) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
  }
  return prefix.join("/");
}

function expandVariables(
  value: string,
  settings: Record<string, string>,
  projectDirectory: string
): string {
  return value
    .replace(/\$\((SRCROOT|PROJECT_DIR)\)/g, projectDirectory)
    .replace(/\$\{(SRCROOT|PROJECT_DIR)\}/g, projectDirectory)
    .replace(/\$\(([A-Za-z0-9_]+)(:[a-zA-Z0-9]+)?\)/g, (match, name: string) =>
      settings[name] && settings[name].length > 0 ? settings[name] : match
    )
    .replace(/\$\{([A-Za-z0-9_]+)(:[a-zA-Z0-9]+)?\}/g, (match, name: string) =>
      settings[name] && settings[name].length > 0 ? settings[name] : match
    );
}

/** Resolves a path-valued build setting (INFOPLIST_FILE, ...) to an absolute path. */
function settingPath(
  settings: Record<string, string>,
  key: string,
  projectDirectory: string
): string | null {
  const raw = settings[key];
  if (!raw || raw.length === 0) return null;
  const expanded = normalize(expandVariables(raw, settings, projectDirectory));
  return isAbsolutePath(expanded) ? expanded : joinPath(projectDirectory, expanded);
}

// ---------------------------------------------------------- package deps --

interface PackageCollection {
  list: ImportPackageDependency[];
  /** Maps an `XCRemoteSwiftPackageReference`/`XCLocalSwiftPackageReference` id to an identity. */
  byReference: Map<string, string>;
  /**
   * Xcode can add a local package without any package reference object: the
   * folder shows up as a `PBXFileReference` (a "wrapper") and the target links
   * its product. Resolves that product name to a package identity.
   */
  registerFolderPackage: (
    productName: string,
    index: Map<string, FileIndexEntry>
  ) => string | null;
}

function describeRequirement(requirement: PbxDict): string | null {
  const kind = asString(requirement.kind);
  const version = asString(requirement.minimumVersion) || asString(requirement.version);
  switch (kind) {
    case "upToNextMajorVersion":
      return version.length > 0 ? `from: ${JSON.stringify(version)}` : null;
    case "upToNextMinorVersion":
      return version.length > 0 ? `from: ${JSON.stringify(version)}` : null;
    case "exactVersion":
      return version.length > 0 ? `exact: ${JSON.stringify(version)}` : null;
    case "branch": {
      const branch = asString(requirement.branch);
      return branch.length > 0 ? `branch: ${JSON.stringify(branch)}` : null;
    }
    case "revision": {
      const revision = asString(requirement.revision);
      return revision.length > 0 ? `revision: ${JSON.stringify(revision)}` : null;
    }
    default:
      return null;
  }
}

/**
 * Swift package dependencies of the project: local folders are referenced by
 * path, remote ones by URL (SwiftPM resolves those when building).
 */
function collectPackages(
  document: PbxDocument,
  projectDirectory: string,
  packageRoot: string,
  warnings: string[],
  listDirectory: PlanOptions["listDirectory"]
): PackageCollection {
  const list: ImportPackageDependency[] = [];
  const byReference = new Map<string, string>();
  const seen = new Set<string>();
  const folderPackages = new Map<string, string>();
  const warnedProducts = new Set<string>();

  for (const referenceId of asArray(document.rootObject.packageReferences).map((id) => asString(id))) {
    const reference = objectAt(document, referenceId);
    const isa = isaOf(reference);

    if (isa === "XCLocalSwiftPackageReference") {
      const relativePath = asString(reference.relativePath);
      if (relativePath.length === 0) continue;
      const identity = swiftIdentifier(baseName(relativePath));
      byReference.set(referenceId, identity);
      const absolute = isAbsolutePath(relativePath)
        ? normalize(relativePath)
        : joinPath(projectDirectory, relativePath);
      const relative = relativeTo(packageRoot, absolute);
      if (relative === null) {
        warnings.push(
          `Local package "${relativePath}" is outside the project folder and was not added to Package.swift.`
        );
        continue;
      }
      if (seen.has(identity)) continue;
      seen.add(identity);
      list.push({ identity, kind: "local", location: relative, requirement: null });
      continue;
    }

    if (isa === "XCRemoteSwiftPackageReference") {
      const url = asString(reference.repositoryURL);
      if (url.length === 0) continue;
      const identity = swiftIdentifier(baseName(url).replace(/\.git$/, ""));
      byReference.set(referenceId, identity);
      if (seen.has(identity)) continue;
      seen.add(identity);
      list.push({
        identity,
        kind: "remote",
        location: url,
        requirement: describeRequirement(asDict(reference.requirement)),
      });
      warnings.push(
        `Remote package "${identity}" is declared in Package.swift; SwiftPM downloads it when the project is built.`
      );
    }
  }

  const registerFolderPackage = (
    productName: string,
    index: Map<string, FileIndexEntry>
  ): string | null => {
    if (productName.length === 0) return null;
    const identity = swiftIdentifier(productName);
    if (seen.has(identity) || folderPackages.has(productName)) {
      return folderPackages.get(productName) ?? identity;
    }

    // find the folder reference with this name
    let folderPath: string | null = null;
    for (const [id, object] of Object.entries(document.objects)) {
      if (isaOf(object) !== "PBXFileReference") continue;
      const path = asString(object.path) || asString(object.name);
      if (baseName(path) !== productName) continue;
      if (asString(object.lastKnownFileType) !== "wrapper") continue;
      folderPath = index.get(id)?.path ?? null;
      if (folderPath) break;
    }
    if (!folderPath) {
      if (!warnedProducts.has(productName)) {
        warnedProducts.add(productName);
        warnings.push(
          `Package product "${productName}" has no matching folder in the project; add it to Package.swift manually.`
        );
      }
      return null;
    }

    const relative = relativeTo(packageRoot, folderPath);
    if (relative === null || relative.length === 0) {
      warnings.push(
        `Local package "${productName}" is outside the project folder; add it to Package.swift manually.`
      );
      return null;
    }

    let isPackage = true;
    if (listDirectory) {
      try {
        const entries = listDirectory(folderPath).map((entry) => baseName(normalize(entry)));
        isPackage = entries.includes("Package.swift");
      } catch {
        isPackage = true;
      }
    }
    if (!isPackage) {
      if (!warnedProducts.has(productName)) {
        warnedProducts.add(productName);
        warnings.push(
          `"${productName}" was referenced as a package but contains no Package.swift; add the dependency manually.`
        );
      }
      return null;
    }

    list.push({ identity, kind: "local", location: relative, requirement: null });
    seen.add(identity);
    folderPackages.set(productName, identity);
    return identity;
  };

  return { list, byReference, registerFolderPackage };
}

// ---------------------------------------------------------- file path index --

interface FileIndexEntry {
  /** Absolute path for groups and file references. */
  path: string;
  isFile: boolean;
  sourceTree: string;
}

/**
 * Maps group ids and file reference ids to absolute paths, following the
 * `sourceTree` rules Xcode uses. Products and SDK roots are skipped: they never
 * contain user sources.
 */
export function indexFilePaths(
  document: PbxDocument,
  mainGroupId: string | null
): Map<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  const skippedTrees = new Set(["BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR"]);

  const resolveGroupBase = (sourceTree: string, ownPath: string, parent: string): string | null => {
    if (skippedTrees.has(sourceTree)) return null;
    if (sourceTree === "SOURCE_ROOT" || sourceTree === "<absolute>") {
      return isAbsolutePath(ownPath) ? normalize(ownPath) : joinPath(document.projectDirectory, ownPath);
    }
    if (ownPath.length === 0) return parent;
    return isAbsolutePath(ownPath) ? normalize(ownPath) : joinPath(parent, ownPath);
  };

  const visit = (id: string, parent: string) => {
    const object = objectAt(document, id);
    const isa = isaOf(object);
    const sourceTree = asString(object.sourceTree);
    // a group's `name` is only a label; a file reference's `name` is its file name
    const ownPath =
      isa === "PBXFileReference"
        ? asString(object.path) || asString(object.name)
        : asString(object.path);

    if (isa === "PBXFileReference") {
      if (skippedTrees.has(sourceTree)) return;
      const path = isAbsolutePath(ownPath) ? normalize(ownPath) : joinPath(parent, ownPath);
      index.set(id, { path, isFile: true, sourceTree });
      return;
    }

    const base = resolveGroupBase(sourceTree, ownPath, parent);
    if (base === null) return;
    index.set(id, { path: base, isFile: false, sourceTree });

    for (const childId of [...asArray(object.children), ...asArray(object.files)]) {
      visit(asString(childId), base);
    }
  };

  if (mainGroupId) {
    const group = objectAt(document, mainGroupId);
    const base = resolveGroupBase(
      asString(group.sourceTree),
      asString(group.path),
      document.projectDirectory
    );
    if (base !== null) {
      index.set(mainGroupId, { path: base, isFile: false, sourceTree: asString(group.sourceTree) });
      for (const childId of [...asArray(group.children), ...asArray(group.files)]) {
        visit(asString(childId), base);
      }
    }
  }

  return index;
}

// -------------------------------------------------------------- generators --

const DEFAULT_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>[[product]]</string>
	<key>CFBundleExecutable</key>
	<string>[[product]]</string>
	<key>CFBundleIdentifier</key>
	<string>[[bundle_id]]</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>[[version_string]]</string>
	<key>CFBundleVersion</key>
	<string>[[version_num]]</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>iPhoneOS</string>
	</array>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>arm64</string>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
</dict>
</plist>
`;

/**
 * Rewrites an Xcode Info.plist so CrossCode controls the bundle id and the
 * versions: those four fields become `[[...]]` placeholders, and every other
 * `$(SETTING)` is expanded with the project's build settings.
 */
export function convertInfoPlist(text: string, settings: Record<string, string>, projectDirectory = ""): string {
  const placeholders: Record<string, string> = {
    CFBundleIdentifier: "[[bundle_id]]",
    CFBundleName: "[[product]]",
    CFBundleExecutable: "[[product]]",
    CFBundleVersion: "[[version_num]]",
    CFBundleShortVersionString: "[[version_string]]",
  };

  let result = text;
  for (const [key, placeholder] of Object.entries(placeholders)) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([\\s\\S]*?)(</string>)`, "g");
    result = result.replace(pattern, (_match, before: string, _value: string, after: string) => {
      return `${before}${placeholder}${after}`;
    });
  }

  return expandVariables(result, settings, projectDirectory);
}

/** Values Xcode substitutes in an Info.plist that are not settings themselves. */
function withPlistDefaults(settings: Record<string, string>): Record<string, string> {
  return {
    EXECUTABLE_NAME: settings.PRODUCT_NAME ?? "",
    PRODUCT_MODULE_NAME: swiftIdentifier(settings.PRODUCT_NAME ?? ""),
    ...settings,
  };
}

export function generatePackageSwift(
  packageName: string,
  targets: ImportTarget[],
  platformVersion: string | null,
  packages: ImportPackageDependency[] = []
): string {
  const converted = targets.filter((target) => target.swiftPackageTargetType !== null);
  const appTarget = converted.find((target) => target.kind === "app") ?? null;

  const lines: string[] = [];
  lines.push("// swift-tools-version: 6.4");
  lines.push("// Generated by CrossCode from an Xcode project.");
  lines.push("");
  lines.push("import PackageDescription");
  lines.push("");
  lines.push("let package = Package(");
  lines.push(`    name: ${JSON.stringify(packageName)},`);
  if (platformVersion) {
    // the string overload accepts any x.y[.z] deployment target
    lines.push(`    platforms: [.iOS(${JSON.stringify(platformVersion)})],`);
  }
  if (appTarget) {
    lines.push("    products: [");
    lines.push(
      `        .executable(name: ${JSON.stringify(packageName)}, targets: [${JSON.stringify(
        appTarget.swiftName
      )}]),`
    );
    lines.push("    ],");
  }
  if (packages.length > 0) {
    lines.push("    dependencies: [");
    for (const dependency of packages) {
      if (dependency.kind === "local") {
        lines.push(`        .package(path: ${JSON.stringify(dependency.location)}),`);
      } else {
        const requirement = dependency.requirement ?? "from: \"0.0.0\"";
        lines.push(
          `        .package(url: ${JSON.stringify(dependency.location)}, ${requirement}),`
        );
      }
    }
    lines.push("    ],");
  }
  lines.push("    targets: [");

  for (const target of converted) {
    const dependencies = target.dependencies
      .map((name) => converted.find((candidate) => candidate.name === name))
      .filter((dependency): dependency is ImportTarget => Boolean(dependency))
      .filter((dependency) => dependency.id !== target.id)
      .map((dependency) => dependency.swiftName);

    lines.push(
      target.swiftPackageTargetType === "executable" ? "        .executableTarget(" : "        .target("
    );
    lines.push(`            name: ${JSON.stringify(target.swiftName)},`);
    const productDependencies = target.packageProducts.filter((product) => product.package);
    if (dependencies.length > 0 || productDependencies.length > 0) {
      lines.push("            dependencies: [");
      for (const dependency of dependencies) {
        lines.push(`                .target(name: ${JSON.stringify(dependency)}),`);
      }
      for (const product of productDependencies) {
        lines.push(
          `                .product(name: ${JSON.stringify(product.productName)}, package: ${JSON.stringify(
            product.package
          )}),`
        );
      }
      lines.push("            ],");
    }
    lines.push(`            path: ${JSON.stringify(target.path ?? ".")},`);
    if (target.excludes.length > 0) {
      lines.push("            exclude: [");
      for (const exclude of target.excludes) {
        lines.push(`                ${JSON.stringify(exclude)},`);
      }
      lines.push("            ],");
    }
    lines.push("        ),");
  }

  lines.push("    ]");
  lines.push(")");
  lines.push("");
  return lines.join("\n");
}

export function generateCrosscodeToml(
  bundleId: string,
  versionNum: string,
  versionString: string
): string {
  return `format_version = 1

[project]
version_num = ${JSON.stringify(versionNum)}
version_string = ${JSON.stringify(versionString)}
bundle_id = ${JSON.stringify(bundleId)}
`;
}

// ------------------------------------------------------------------- plan --

interface RawTarget {
  id: string;
  name: string;
  packageProducts: { productName: string; package: string | null }[];
  kind: ImportTargetKind;
  productType: string;
  settings: Record<string, string>;
  sources: string[];
  resources: string[];
  synchronizedDirectories: string[];
  dependencies: string[];
}

function collectTargetFiles(
  document: PbxDocument,
  index: Map<string, FileIndexEntry>,
  target: PbxDict,
  listDirectory: PlanOptions["listDirectory"],
  warnings: string[]
): { sources: string[]; resources: string[]; synchronous: string[] } {
  const sources: string[] = [];
  const resources: string[] = [];
  const synchronous: string[] = [];

  for (const phaseId of asArray(target.buildPhases).map((id) => asString(id))) {
    const phase = objectAt(document, phaseId);
    const isa = isaOf(phase);
    if (isa !== "PBXSourcesBuildPhase" && isa !== "PBXResourcesBuildPhase") continue;
    for (const file of buildPhaseFiles(document, phaseId)) {
      const entry = index.get(file.fileRefId);
      if (!entry) continue;
      if (isa === "PBXSourcesBuildPhase") {
        if (isSourceFile(entry.path)) sources.push(entry.path);
        else warnings.push(`"${baseName(entry.path)}" is not a compilable source and was skipped.`);
      } else {
        resources.push(entry.path);
      }
    }
  }

  // Xcode 16+ "synchronized" groups describe a directory instead of listing its
  // files, so the directory has to be walked.
  for (const groupId of asArray(target.fileSystemSynchronizedGroups).map((id) => asString(id))) {
    const entry = index.get(groupId);
    if (!entry) continue;
    synchronous.push(entry.path);
    if (!listDirectory) continue;
    walk(entry.path, listDirectory, sources, resources, 0, warnings);
  }

  return {
    sources: [...new Set(sources)],
    resources: [...new Set(resources)],
    synchronous,
  };
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function walk(
  directory: string,
  listDirectory: (absolutePath: string) => string[],
  sources: string[],
  resources: string[],
  depth: number,
  warnings: string[]
): void {
  if (depth > 12) return;
  let entries: string[] = [];
  try {
    entries = listDirectory(directory);
  } catch {
    warnings.push(`Could not read ${directory}.`);
    return;
  }
  for (const rawEntry of entries) {
    const entry = normalize(rawEntry);
    const name = baseName(entry);
    if (name === ".DS_Store" || name.endsWith(".xcodeproj") || name === "DerivedData") continue;
    const extension = extensionOf(entry);
    if (extension.length === 0) {
      // directory (or no extension): descend, but not into asset catalogs
      walk(entry, listDirectory, sources, resources, depth + 1, warnings);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extension)) sources.push(entry);
    else if (RESOURCE_EXTENSIONS.has(extension)) resources.push(entry);
  }
}

/**
 * Reads an Xcode project and produces everything needed to write a CrossCode
 * package: the SwiftPM manifest, `crosscode.toml`, an Info.plist, and the list
 * of resources to copy.
 */
export function planImport(
  pbxText: string,
  xcodeprojPath: string,
  options: PlanOptions = {}
): ImportPlan {
  const configuration = options.configuration ?? "Release";
  const normalizedProject = normalize(xcodeprojPath);
  const projectDirectory = dirOf(normalizedProject);
  const document = loadDocument(pbxText, projectDirectory);
  const warnings: string[] = [];

  const projectName =
    options.packageName ??
    (baseName(normalizedProject).replace(/\.xcodeproj$/i, "") || "ImportedProject");
  const packageName = swiftIdentifier(projectName);
  const packageRoot = normalize(options.packageRoot ?? projectDirectory);

  const projectListId = asString(document.rootObject.buildConfigurationList);
  const projectSettings = resolveBuildSettings(document, projectListId, configuration);
  const fileIndex = indexFilePaths(document, asString(document.rootObject.mainGroup));

  const usedNames = new Set<string>();
  const rawTargets: RawTarget[] = [];
  const packages = collectPackages(
    document,
    projectDirectory,
    packageRoot,
    warnings,
    options.listDirectory
  );

  for (const targetId of asArray(document.rootObject.targets).map((id) => asString(id))) {
    const object = objectAt(document, targetId);
    if (isaOf(object) !== "PBXNativeTarget") {
      warnings.push(`Skipped "${objectName(object)}": not a native target.`);
      continue;
    }
    const name = asString(object.name) || objectName(object);
    const productType = asString(object.productType);
    const settings = resolveBuildSettings(
      document,
      asString(object.buildConfigurationList),
      configuration,
      projectSettings
    );
    settings.TARGET_NAME = name;

    const collected = collectTargetFiles(document, fileIndex, object, options.listDirectory, warnings);

    const packageProducts = asArray(object.packageProductDependencies)
      .map((productId) => objectAt(document, asString(productId)))
      .map((product) => {
        const referenceId = asString(product.package);
        if (referenceId.length > 0) {
          return {
            productName: asString(product.productName),
            package: packages.byReference.get(referenceId) ?? null,
          };
        }
        // Xcode also records local packages as a folder reference plus a bare
        // product dependency, without any package reference object.
        const productName = asString(product.productName);
        return {
          productName,
          package: packages.registerFolderPackage(productName, fileIndex),
        };
      })
      .filter((product) => product.productName.length > 0);

    rawTargets.push({
      id: targetId,
      name,
      packageProducts,
      kind: mapProductType(productType),
      productType,
      settings,
      sources: collected.sources,
      resources: collected.resources,
      synchronizedDirectories: collected.synchronous,
      dependencies: asArray(object.dependencies)
        .map((dependencyId) => asString(objectAt(document, asString(dependencyId)).target))
        .filter((value) => value.length > 0),
    });
  }

  // SwiftPM cannot have two targets compiling the same files, and Xcode
  // projects often ship several app targets (a "Lite" variant, a "All"
  // variant, ...). Import the one matching the project name.
  const appCandidates = rawTargets.filter((raw) => raw.kind === "app");
  const chosenApp =
    appCandidates.find((raw) => swiftIdentifier(raw.name) === packageName) ?? appCandidates[0] ?? null;

  const targets: ImportTarget[] = [];
  const directoriesByTarget = new Map<string, string | null>();

  for (const raw of rawTargets) {
    const relativeSources = raw.sources
      .map((absolute) => relativeTo(packageRoot, absolute))
      .filter((path): path is string => path !== null);
    const missing = raw.sources.filter((absolute) => relativeTo(packageRoot, absolute) === null);

    let swiftName = swiftIdentifier(raw.name);
    while (usedNames.has(swiftName)) swiftName = `${swiftName}_`;
    usedNames.add(swiftName);

    const sourceDirectory =
      relativeSources.length > 0 ? commonDirectory(relativeSources) || "." : null;
    directoriesByTarget.set(raw.id, sourceDirectory);

    const hasSynchronizedGroups = raw.synchronizedDirectories.length > 0;
    let skippedReason: string | null = null;
    if (raw.kind === "app" && chosenApp && raw.id !== chosenApp.id) {
      skippedReason = `Only one app target is imported ("${chosenApp.name}").`;
    } else if (raw.kind === "test") {
      skippedReason = "Test targets are not converted.";
    } else if (raw.kind === "extension") {
      skippedReason = "App extensions cannot be embedded by CrossCode yet.";
    } else if (raw.kind === "other") {
      skippedReason = `Unsupported product type (${raw.productType}).`;
    } else if (relativeSources.length === 0) {
      skippedReason = hasSynchronizedGroups
        ? "Its sources could not be listed (synchronized Xcode groups)."
        : "No sources were found for this target.";
    } else if (missing.length > 0) {
      skippedReason = "Some sources live outside the project directory.";
    }

    const bundleIdCandidate = raw.settings.PRODUCT_BUNDLE_IDENTIFIER ?? "";
    targets.push({
      id: raw.id,
      name: raw.name,
      swiftName,
      productType: raw.productType,
      kind: raw.kind,
      swiftPackageTargetType:
        skippedReason !== null ? null : raw.kind === "app" ? "executable" : "regular",
      productName: raw.settings.PRODUCT_NAME || raw.name,
      sourceDirectory,
      path: skippedReason !== null ? null : sourceDirectory,
      excludes: [],
      sources: relativeSources,
      resources: raw.resources
        .map((absolute) => relativeTo(packageRoot, absolute))
        .filter((path): path is string => path !== null),
      dependencies: raw.dependencies.map((id) => asString(objectAt(document, id).name)),
      packageProducts: raw.packageProducts,
      bundleId:
        bundleIdCandidate.length > 0 && !bundleIdCandidate.includes("$(")
          ? bundleIdCandidate
          : `com.example.${packageName.toLowerCase()}`,
      deploymentTarget: raw.settings.IPHONEOS_DEPLOYMENT_TARGET ?? "",
      settings: raw.settings,
      skippedReason,
    });
  }

  const app = targets.find((target) => target.kind === "app" && target.skippedReason === null);
  if (!app) {
    const reason =
      targets.find((target) => target.kind === "app")?.skippedReason ??
      "the project has no application target";
    throw new ImportError(`CrossCode can only import projects with a buildable app target (${reason}).`);
  }

  // Every file that must not be compiled as part of a target gets excluded.
  // Files shared between targets stay in all of them (SwiftPM cannot share
  // sources between targets, but a file may be compiled into several modules).
  const xcodeprojName = baseName(normalizedProject);
  const packagePaths = packages.list
    .filter((dependency) => dependency.kind === "local")
    .map((dependency) => dependency.location);

  // A file compiled by several *converted* targets is a SwiftPM error, so such
  // files go to the app target only (that is the one CrossCode builds).
  const sharedWithApp = new Map<string, string[]>();
  for (const target of targets) {
    if (target.id === app.id || target.swiftPackageTargetType === null) continue;
    const shared = target.sources.filter((source) => app.sources.includes(source));
    if (shared.length > 0) sharedWithApp.set(target.id, shared);
  }
  for (const [targetId, shared] of sharedWithApp) {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) continue;
    target.excludes = pruneExcludes([...target.excludes, ...shared]);
    warnings.push(
      `${shared.length} file(s) are shared with the app target and were assigned to it (${target.name} will not compile them).`
    );
  }

  for (const target of targets) {
    if (!target.path || target.swiftPackageTargetType === null) continue;
    const base = target.path;
    const excludes = new Set<string>();
    const add = (path: string) => {
      if (path.length === 0 || path === base) return;
      const relative = base === "." ? path : isUnder(base, path) ? path.slice(base.length + 1) : null;
      if (relative && relative.length > 0 && !relative.startsWith("..")) excludes.add(relative);
    };

    for (const junk of [
      "Info.plist",
      "crosscode.toml",
      "Package.swift",
      "Resources",
      ".crosscode",
      ".build",
      "DerivedData",
      xcodeprojName,
      ...packagePaths,
    ]) {
      add(junk);
    }

    for (const other of targets) {
      if (other.id === target.id || other.sources.length === 0) continue;
      const shared = other.sources.filter((source) => target.sources.includes(source));
      const foreign = other.sources.filter(
        (source) => !target.sources.includes(source) && isUnder(base, source)
      );
      if (foreign.length === 0) continue;
      if (shared.length === 0 && other.sourceDirectory && other.sourceDirectory !== base) {
        add(other.sourceDirectory);
      } else {
        for (const source of foreign) add(source);
      }
    }

    // resources are copied into the package's Resources folder: keep the target
    // from reporting them as unhandled files
    for (const resource of target.resources) add(resource);

    target.excludes = pruneExcludes([...excludes]);
  }

  // plain resources are copied so CrossCode can put them into the .app
  const copies: { from: string; to: string }[] = [];
  const warnedUnsupported = new Set<string>();
  const copiedSources = new Set<string>();
  const usedResourceNames = new Set<string>();
  for (const target of targets) {
    // only converted targets are built, so only their resources are needed
    if (target.swiftPackageTargetType === null) continue;
    const absoluteResources = rawTargets.find((raw) => raw.id === target.id)?.resources ?? [];
    for (const resource of absoluteResources) {
      if (copiedSources.has(resource)) continue;
      const extension = extensionOf(resource);
      if (UNSUPPORTED_EXTENSIONS.has(extension)) {
        if (!warnedUnsupported.has(extension)) {
          warnedUnsupported.add(extension);
          warnings.push(
            `"${baseName(resource)}" needs Xcode's compilers (${extension}) and will not be available on the device.`
          );
        }
        continue;
      }
      if (!RESOURCE_EXTENSIONS.has(extension)) continue;
      copiedSources.add(resource);

      // localised resources keep their .lproj placement in the app bundle
      const parts = resource.split("/");
      const localeIndex = parts.findIndex((part) => part.endsWith(".lproj"));
      const fileName = parts[parts.length - 1];
      let destination =
        localeIndex >= 0 ? `Resources/${parts[localeIndex]}/${fileName}` : `Resources/${fileName}`;
      let counter = 2;
      while (usedResourceNames.has(destination)) {
        destination =
          localeIndex >= 0
            ? `Resources/${parts[localeIndex]}/${fileName.replace(/(\.[^.]+)$/, `-${counter}$1`)}`
            : `Resources/${fileName.replace(/(\.[^.]+)$/, `-${counter}$1`)}`;
        counter += 1;
      }
      usedResourceNames.add(destination);
      copies.push({ from: resource, to: destination });
    }
  }

  // Info.plist
  const infoPlistSetting = settingPath(app.settings, "INFOPLIST_FILE", projectDirectory);
  let infoPlistText: string | null = null;
  let infoPlistSource: string | null = null;
  if (infoPlistSetting && infoPlistSetting.toLowerCase().endsWith(".plist")) {
    const contents = options.readFile ? options.readFile(infoPlistSetting) : null;
    if (contents !== null && contents !== undefined) {
      infoPlistText = convertInfoPlist(
        contents,
        withPlistDefaults({ ...projectSettings, ...app.settings }),
        projectDirectory
      );
      infoPlistSource = infoPlistSetting;
    } else {
      warnings.push(`Could not read ${infoPlistSetting}; a default Info.plist was generated instead.`);
    }
  } else if (app.settings.GENERATE_INFOPLIST_FILE === "YES") {
    warnings.push("The project generates its Info.plist at build time; a default one was generated.");
  }
  if (infoPlistText === null) {
    infoPlistText = convertInfoPlist(
      DEFAULT_INFO_PLIST,
      withPlistDefaults({ ...projectSettings, ...app.settings }),
      projectDirectory
    );
  }

  // the Info.plist usually lives inside the app target's directory
  if (infoPlistSource && app.path) {
    const packageRelative = relativeTo(packageRoot, infoPlistSource);
    if (packageRelative) {
      const relative =
        app.path === "."
          ? packageRelative
          : isUnder(app.path, packageRelative)
            ? packageRelative.slice(app.path.length + 1)
            : null;
      if (relative && relative.length > 0) {
        app.excludes = pruneExcludes([...app.excludes, relative]);
      }
    }
  }

  const deploymentTarget =
    app.deploymentTarget || projectSettings.IPHONEOS_DEPLOYMENT_TARGET || "17.0";
  const platformVersion = /^[0-9]+(\.[0-9]+){1,2}$/.test(deploymentTarget) ? deploymentTarget : "17.0";

  const extensions = targets.filter((target) => target.kind === "extension");
  if (extensions.length > 0) {
    warnings.push(
      `Skipped ${extensions.length} app extension target(s) (${extensions
        .map((target) => target.name)
        .join(", ")}): CrossCode can build and install the app, but not embed extensions yet.`
    );
  }
  return {
    packageRoot,
    packageName,
    productName: packageName,
    targets,
    warnings,
    packages: packages.list,
    files: [
      {
        path: "Package.swift",
        contents: generatePackageSwift(packageName, targets, platformVersion, packages.list),
      },
      {
        path: "crosscode.toml",
        contents: generateCrosscodeToml(
          app.bundleId,
          app.settings.CURRENT_PROJECT_VERSION || "1",
          app.settings.MARKETING_VERSION || "1.0.0"
        ),
      },
      { path: "Info.plist", contents: infoPlistText },
    ],
    copies,
    settings: { ...projectSettings, ...app.settings },
    configuration,
    infoPlistSource,
  };
}

function mapProductType(productType: string): ImportTargetKind {
  switch (productType) {
    case "com.apple.product-type.application":
      return "app";
    case "com.apple.product-type.framework":
    case "com.apple.product-type.library.dynamic":
    case "com.apple.product-type.library.static":
    case "com.apple.product-type.bundle":
      return "framework";
    case "com.apple.product-type.app-extension":
    case "com.apple.product-type.extensionkit-extension":
    case "com.apple.product-type.watchkit2-extension":
    case "com.apple.product-type.widgetkit-extension":
      return "extension";
    case "com.apple.product-type.bundle.unit-test":
    case "com.apple.product-type.bundle.ui-testing":
      return "test";
    default:
      return "other";
  }
}
