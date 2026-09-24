// Code generation tests for the visual UI builder.
//
// Run with `bun test src/ui-builder` (see .github/workflows/build.yml).

import { describe, expect, test } from "bun:test";
import { generateSwift } from "./codegen";
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

describe("generateSwift", () => {
  test("renders containers, children and modifiers", () => {
    const source = generateSwift(
      doc(
        node("VStack", { alignment: "leading", spacing: "16", padding: "16" }, [
          node("Text", { text: "Hello, world!", font: ".largeTitle", weight: ".bold" }),
          node("Image", { source: "symbol", name: "star", resizable: true, frameWidth: "24" }),
        ])
      )
    );

    expect(source).toBe(
      `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Hello, world!")
                .font(.largeTitle)
                .fontWeight(.bold)
            Image(systemName: "star")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 24)
        }
        .padding(16)
    }
}
`
    );
  });

  test("escapes string literals", () => {
    const source = generateSwift(doc(node("Text", { text: 'He said "hi"\\there' })));
    expect(source).toContain('Text("He said \\"hi\\"\\\\there")');
  });

  test("declares @State once per bound variable and sanitises names", () => {
    const source = generateSwift(
      doc(
        node("VStack", {}, [
          node("Toggle", { title: "On", isOn: "music playing" }),
          node("Toggle", { title: "Also on", isOn: "music playing" }),
          node("Slider", { value: "volume", min: "0", max: "10" }),
        ])
      )
    );

    expect(source).toContain("@State private var musicplaying = false");
    expect(source.split("@State private var musicplaying").length).toBe(2);
    expect(source).toContain("@State private var volume: Double = 0");
    expect(source).toContain("Toggle(\"On\", isOn: $musicplaying)");
    expect(source).toContain("Slider(value: $volume, in: 0...10)");
  });

  test("aligns trailing-closure modifiers with their block", () => {
    const source = generateSwift(
      doc(
        node("VStack", {}, [
          node("Button", { title: "Continue", style: "borderedProminent", padding: "8" }),
        ])
      )
    );

    expect(source).toBe(
      `import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack {
            Button("Continue") {
                // TODO: handle tap
            }
            .buttonStyle(.borderedProminent)
            .padding(8)
        }
    }
}
`
    );
  });

  test("wraps multiple navigation children so navigationTitle applies", () => {
    const source = generateSwift(
      doc(
        node("NavigationStack", { title: "Settings" }, [
          node("Text", { text: "One" }),
          node("Text", { text: "Two" }),
        ])
      )
    );

    expect(source).toContain('.navigationTitle("Settings")');
    expect(source).toContain("Group {");
  });

  test("applies navigationTitle directly to a single child", () => {
    const source = generateSwift(
      doc(node("NavigationStack", { title: "Home" }, [node("Text", { text: "Only" })]))
    );

    expect(source).toBe(
      `import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            Text("Only")
                .navigationTitle("Home")
        }
    }
}
`
    );
  });

  test("converts hex colours and named colours", () => {
    const hex = generateSwift(doc(node("Text", { text: "x", background: "#FF8800" })));
    expect(hex).toContain("Color(red: 1, green: 0.533, blue: 0)");
    const named = generateSwift(doc(node("Text", { text: "x", foreground: "secondary" })));
    expect(named).toContain(".foregroundStyle(.secondary)");
    // invalid colours are dropped rather than generating broken code
    const invalid = generateSwift(doc(node("Text", { text: "x", background: "not-a-colour" })));
    expect(invalid).not.toContain(".background(");
  });

  test("adds a #Preview block only when asked", () => {
    const withPreview = generateSwift(doc(node("Text", { text: "x" }), { includePreview: true }));
    expect(withPreview).toContain("#Preview {\n    ContentView()\n}");

    const withoutPreview = generateSwift(doc(node("Text", { text: "x" })));
    expect(withoutPreview).not.toContain("#Preview");
  });

  test("keeps unknown components visible as a comment", () => {
    const source = generateSwift(doc(node("MapKit", { region: "x" })));
    expect(source).toContain('// Unsupported component "MapKit"');
  });

  test("generates every catalogue component without crashing", async () => {
    const { PALETTE } = await import("./catalog");
    for (const spec of PALETTE) {
      const source = generateSwift(doc(node(spec.kind, { ...spec.defaults })));
      expect(source).toContain("struct ContentView: View {");
      expect(source).not.toContain("Unsupported component");
    }
  });
});
