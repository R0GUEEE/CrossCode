// Tests for the Xcode project importer: the pbxproj parser and the plan that
// turns a project into a CrossCode (SwiftPM) package.
//
// Run with `bun test src/xcode-import`.

import { describe, expect, test } from "bun:test";
import { FIXTURE_INFO_PLIST, FIXTURE_PBX, fixtureDirectory } from "./fixture";
import { ImportError, convertInfoPlist, indexFilePaths, planImport, swiftIdentifier } from "./plan";
import { asDict, asString, loadDocument, parsePbx } from "./pbxproj";

const XCODEPROJ = "/work/MyApp.xcodeproj";

function importFixture(readInfoPlist = true) {
  return planImport(FIXTURE_PBX, XCODEPROJ, {
    packageRoot: "/work",
    readFile: (path) => (readInfoPlist && path === "/work/App/Info.plist" ? FIXTURE_INFO_PLIST : null),
    listDirectory: fixtureDirectory,
  });
}

describe("parsePbx", () => {
  test("parses the fixture into objects and a root object", () => {
    const root = parsePbx(FIXTURE_PBX);
    const objects = asDict(root.objects);
    expect(asString(root.rootObject)).toBe("5E0000000000000000000001");
    expect(Object.keys(objects).length > 40).toBe(true);
    expect(asString(asDict(objects["8B0000000000000000000002"]).path)).toBe("App");
  });

  test("keeps slashes inside bare values (regression)", () => {
    const root = parsePbx(`{
	objects = {
		1 /* en */ = {isa = PBXFileReference; name = en; path = en.lproj/Localizable.strings; sourceTree = "<group>"; };
	};
}`);
    const objects = asDict(root.objects);
    expect(asString(asDict(objects["1"]).path)).toBe("en.lproj/Localizable.strings");
  });

  test("handles comments, arrays, nested dictionaries and data values", () => {
    const root = parsePbx(`{
	/* a block comment */
	// a line comment
	list = (
		"quoted value",
		bare,
	);
	data = <0a1b>;
	nested = {
		empty = {
		};
	};
}`);
    expect(asString(root.data)).toBe("<0a1b>");
    expect((root.list as unknown[]).length).toBe(2);
    expect(Object.keys(asDict(root.nested)).length).toBe(1);
  });

  test("supports escaped quotes", () => {
    const root = parsePbx(`{ message = "say \\"hi\\" please"; }`);
    expect(asString(root.message)).toBe('say "hi" please');
  });

  test("rejects a project without objects", () => {
    let failed = false;
    try {
      loadDocument("{ objectVersion = 56; }", "/work");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("group paths", () => {
  test("resolves nested group paths and ignores group display names", () => {
    const document = loadDocument(FIXTURE_PBX, "/work");
    const index = indexFilePaths(document, asString(document.rootObject.mainGroup));
    // path = "Framework/Sources" on a nested group
    expect(index.get("2B0000000000000000000004")?.path).toBe("/work/Framework/Sources/Kit.swift");
    // the "Products" group only has a display name: no path component
    expect(index.get("2B0000000000000000000008")?.path).toBeUndefined();
    // a variant group adds no path component of its own
    expect(index.get("2B000000000000000000000A")?.path).toBe("/work/App/en.lproj/Localizable.strings");
  });
});

describe("planImport", () => {
  test("generates a package manifest and configuration", () => {
    const plan = importFixture();
    expect(plan.packageName).toBe("MyApp");
    expect(plan.productName).toBe("MyApp");

    const manifest = plan.files.find((file) => file.path === "Package.swift")!.contents;
    expect(manifest).toContain('name: "MyApp"');
    expect(manifest).toContain('platforms: [.iOS("17.0")]');
    expect(manifest).toContain('.executable(name: "MyApp", targets: ["MyApp"])');
    expect(manifest).toContain('.package(path: "LocalKit")');
    expect(manifest).toContain('.product(name: "LocalKit", package: "LocalKit")');
    expect(manifest).toContain('.target(name: "MyKit")');

    const toml = plan.files.find((file) => file.path === "crosscode.toml")!.contents;
    expect(toml).toContain('bundle_id = "com.example.myapp"');
    expect(toml).toContain('version_string = "2.1"');
    expect(toml).toContain('version_num = "42"');
  });

  test("maps targets, paths and exclusions", () => {
    const plan = importFixture();
    const app = plan.targets.find((target) => target.name === "My App")!;
    const kit = plan.targets.find((target) => target.name === "MyKit")!;
    const tests = plan.targets.find((target) => target.name === "MyAppTests")!;

    expect(app.swiftPackageTargetType).toBe("executable");
    // the app compiles App/ only
    expect(app.path).toBe("App");
    expect(app.sources).toContain("App/AppMain.swift");
    expect(app.excludes).toContain("Info.plist");
    expect(app.excludes).toContain("Assets.xcassets");

    expect(kit.swiftPackageTargetType).toBe("regular");
    // the shared file pulls the framework target up to the package root
    expect(kit.path).toBe(".");
    expect(kit.excludes).toContain("App");

    expect(tests.swiftPackageTargetType).toBeNull();
    expect(tests.skippedReason).toContain("Test targets");
  });

  test("assigns files shared by two converted targets to the app", () => {
    const plan = importFixture();
    const app = plan.targets.find((target) => target.name === "My App")!;
    const kit = plan.targets.find((target) => target.name === "MyKit")!;

    expect(app.sources).toContain("App/Shared.swift");
    expect(kit.sources).toContain("App/Shared.swift");
    // only one target may compile it — here the whole App directory is excluded
    expect(kit.excludes).toContain("App");
    expect(kit.excludes).not.toContain("App/Shared.swift");
    expect(plan.warnings.some((warning) => warning.includes("shared"))).toBe(true);
  });

  test("copies resources and keeps localisations in place", () => {
    const plan = importFixture();
    expect(plan.copies.map((copy) => copy.to)).toContain("Resources/en.lproj/Localizable.strings");
    expect(plan.warnings.some((warning) => warning.includes("Assets.xcassets"))).toBe(true);
  });

  test("converts the Info.plist", () => {
    const plan = importFixture();
    const info = plan.files.find((file) => file.path === "Info.plist")!.contents;
    expect(plan.infoPlistSource).toBe("/work/App/Info.plist");
    expect(info).toContain("<string>[[product]]</string>");
    expect(info).toContain("<string>[[bundle_id]]</string>");
    expect(info).toContain("<string>[[version_string]]</string>");
    expect(info).not.toContain("$(PRODUCT_NAME)");
    expect(info).toContain("UILaunchScreen");
  });

  test("falls back to a generated Info.plist", () => {
    const plan = importFixture(false);
    const info = plan.files.find((file) => file.path === "Info.plist")!.contents;
    expect(info).toContain("<key>CFBundleIdentifier</key>");
    expect(plan.infoPlistSource).toBeNull();
    expect(plan.warnings.some((warning) => warning.includes("default Info.plist"))).toBe(true);
  });

  test("rejects projects without an application target", () => {
    const onlyTests = FIXTURE_PBX.replace(
      'productType = "com.apple.product-type.application";',
      'productType = "com.apple.product-type.framework";'
    );
    let message = "";
    try {
      planImport(onlyTests, XCODEPROJ, { packageRoot: "/work", listDirectory: fixtureDirectory });
    } catch (error) {
      message = error instanceof ImportError ? error.message : String(error);
    }
    expect(message).toContain("buildable app target");
  });
});

describe("helpers", () => {
  test("sanitises Swift identifiers", () => {
    expect(swiftIdentifier("Food Truck")).toBe("FoodTruck");
    expect(swiftIdentifier("2 Fast")).toBe("_2Fast");
    expect(swiftIdentifier("!!!")).toBe("Package");
  });

  test("expands build setting variables in an Info.plist", () => {
    const converted = convertInfoPlist("<key>CFBundleDisplayName</key>\n<string>$(PRODUCT_NAME)</string>", {
      PRODUCT_NAME: "My App",
    });
    expect(converted).toContain("<string>My App</string>");
  });
});
