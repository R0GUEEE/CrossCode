// Tests for reading an existing SwiftUI file back into a builder document.
//
// Run with `bun test src/ui-builder` (see .github/workflows/build.yml).

import { describe, expect, test } from "bun:test";
import { generateSwift } from "./codegen";
import { parseSwiftDocument } from "./parse";
import { DEFAULT_VIEW_NAME, DOCUMENT_VERSION, node } from "./types";
import type { UIDocument } from "./types";

function doc(root: UIDocument["root"], overrides: Partial<UIDocument> = {}): UIDocument {
  return {
    version: DOCUMENT_VERSION,
    name: DEFAULT_VIEW_NAME,
    includePreview: false,
    root,
    ...overrides,
  };
}

const SCREENSHOT_SOURCE = `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Hello, world!")
                .font(.largeTitle)
                .fontWeight(.bold)
            Button("Tap me") {
                // TODO: handle tap
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(16)
    }
}

#Preview {
    ContentView()
}
`;

describe("parseSwiftDocument", () => {
  test("reads a view file that the generator produced", () => {
    const parsed = parseSwiftDocument(SCREENSHOT_SOURCE);
    expect(parsed).not.toBeNull();

    const { document, warnings } = parsed!;
    expect(warnings).toEqual([]);
    expect(document.name).toBe("ContentView");
    expect(document.includePreview).toBe(true);

    expect(document.root.kind).toBe("VStack");
    expect(document.root.props).toEqual({ alignment: "leading", spacing: "16", padding: "16" });

    expect(document.root.children.map((child) => child.kind)).toEqual(["Text", "Button"]);
    expect(document.root.children[0].props).toEqual({
      text: "Hello, world!",
      font: ".largeTitle",
      weight: ".bold",
    });
    expect(document.root.children[1].props).toEqual({
      title: "Tap me",
      style: "borderedProminent",
    });
  });

  test("ignores files that are not SwiftUI views", () => {
    expect(parseSwiftDocument("@main struct MyApp: App { var body: some Scene { WindowGroup { } } }"))
      .toBeNull();
    expect(parseSwiftDocument("struct Model { let id = 1 }")).toBeNull();
  });

  test("reports components and modifiers it cannot represent", () => {
    const parsed = parseSwiftDocument(
      `struct V: View {
        var body: some View {
            VStack {
                MapView()
                Text("hi").tracking(2)
            }
        }
    }`
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.warnings.length).toBe(2);
    expect(parsed!.document.root.children[0].kind).toBe("MapView");
  });

  test("round-trips generated code for every supported component", () => {
    const original = doc(
      node("VStack", { alignment: "leading", spacing: "16", padding: "16" }, [
        node("Text", { text: "Title", font: ".title", weight: ".semibold", foreground: ".blue" }),
        node("Label", { title: "Settings", systemImage: "gearshape" }),
        node("Image", {
          source: "symbol",
          name: "star",
          resizable: true,
          frameWidth: "24",
          frameHeight: "24",
          background: ".gray",
          cornerRadius: "8",
          opacity: "0.5",
        }),
        node("HStack", { spacing: "12" }, [
          node("Toggle", { title: "Enabled", isOn: "isEnabled" }),
          node("TextField", { placeholder: "Name", text: "name" }),
          node("SecureField", { placeholder: "Password", text: "password" }),
        ]),
        node("Button", { title: "Go", systemImage: "play", style: "borderedProminent" }),
        node("Picker", { title: "Size", selection: "size", options: "Small, Medium" }),
        node("Slider", { value: "volume", min: "0", max: "1" }),
        node("Stepper", { title: "Count", value: "count" }),
        node("DatePicker", { title: "Date", selection: "date", components: "date" }),
        node("ProgressView", { title: "Loading", value: "0.5" }),
        node("Spacer"),
        node("Divider"),
        node("Section", { header: "More" }, [node("Text", { text: "row" })]),
        node("NavigationStack", { title: "Home" }, [node("Text", { text: "Hello" })]),
        node("ScrollView", { axis: "horizontal" }, [node("Text", { text: "x" })]),
        node("List", {}, [node("Text", { text: "row" })]),
        node("Form", {}, [node("Text", { text: "row" })]),
        node("ZStack", {}, [node("Text", { text: "z" })]),
        node("Group", {}, [node("Text", { text: "g" })]),
      ]),
      { includePreview: true }
    );

    const source = generateSwift(original);
    const parsed = parseSwiftDocument(source, { name: "ContentView" });
    expect(parsed).not.toBeNull();
    expect(parsed!.warnings).toEqual([]);
    expect(generateSwift(parsed!.document)).toBe(source);
  });
});
