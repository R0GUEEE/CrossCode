// Catalog of the SwiftUI views the builder can create.
//
// Every entry is one palette item, one inspector form and one code generator:
//  * `swift` renders the view expression (containers return their opening line
//    ending in "{" — the body and closing brace are added by the generator),
//  * `preview` renders an HTML approximation for the canvas,
//  * `fields` drives the inspector, and `defaults` seeds a fresh node.

import type { CSSProperties, ReactNode } from "react";
import {
  INDENT,
  appendModifier,
  bool,
  csv,
  indentLines,
  num,
  parseColor,
  str,
  swiftColor,
  swiftIdentifier,
  swiftNumber,
  swiftString,
} from "./format";
import type { Props, UINode } from "./types";

export type Category = "Layout" | "Text" | "Controls" | "Media" | "Other";

export const CATEGORY_ORDER: Category[] = [
  "Layout",
  "Text",
  "Controls",
  "Media",
  "Other",
];

export type StateValueType = "Bool" | "String" | "Double" | "Int" | "Date";

export const STATE_DEFAULTS: Record<StateValueType, string> = {
  Bool: "false",
  String: '""',
  Double: "0",
  Int: "0",
  Date: "Date()",
};

export type PropField =
  | { key: string; label: string; type: "string"; placeholder?: string }
  | { key: string; label: string; type: "number"; placeholder?: string }
  | { key: string; label: string; type: "bool" }
  | { key: string; label: string; type: "enum"; options: string[] }
  | { key: string; label: string; type: "state"; valueType: StateValueType };

export type Spec = {
  kind: string;
  label: string;
  category: Category;
  /** Containers render their children on the canvas and in the generated code. */
  container: boolean;
  summary: string;
  defaults: Props;
  fields: PropField[];
  swift: (node: UINode, children: string[][]) => string[];
  preview: (node: UINode, children: ReactNode) => ReactNode;
  /**
   * Optional hook for containers that need to wrap or decorate their children
   * for Swift reasons (e.g. `NavigationStack` + `navigationTitle`).
   */
  childModifiers?: (children: string[][], node: UINode) => string[][];
};

// ---------------------------------------------------------------- modifiers --

export const MODIFIER_FIELDS: PropField[] = [
  {
    key: "font",
    label: "Font",
    type: "enum",
    options: [
      "",
      ".largeTitle",
      ".title",
      ".title2",
      ".title3",
      ".headline",
      ".subheadline",
      ".body",
      ".callout",
      ".footnote",
      ".caption",
      ".caption2",
    ],
  },
  {
    key: "weight",
    label: "Weight",
    type: "enum",
    options: [
      "",
      ".ultraLight",
      ".thin",
      ".light",
      ".regular",
      ".medium",
      ".semibold",
      ".bold",
      ".heavy",
      ".black",
    ],
  },
  {
    key: "foreground",
    label: "Foreground",
    type: "string",
    placeholder: ".blue, .secondary or #FF8800",
  },
  { key: "padding", label: "Padding", type: "number", placeholder: "8" },
  { key: "frameWidth", label: "Width", type: "number", placeholder: "200" },
  { key: "frameHeight", label: "Height", type: "number", placeholder: "44" },
  {
    key: "background",
    label: "Background",
    type: "string",
    placeholder: ".gray, #F2F2F7",
  },
  { key: "cornerRadius", label: "Corner Radius", type: "number", placeholder: "12" },
  { key: "opacity", label: "Opacity", type: "number", placeholder: "0.5" },
];

/** Swift modifier chain for a node, in a stable order. */
export function modifierLines(node: UINode): string[] {
  const lines: string[] = [];
  const font = str(node.props.font);
  if (font) lines.push(`.font(${font.startsWith(".") ? font : `.${font}`})`);

  const weight = str(node.props.weight);
  if (weight) {
    lines.push(`.fontWeight(${weight.startsWith(".") ? weight : `.${weight}`})`);
  }

  const foreground = swiftColor(str(node.props.foreground));
  if (foreground) lines.push(`.foregroundStyle(${foreground})`);

  const padding = num(node.props.padding);
  if (padding !== null) lines.push(`.padding(${swiftNumber(padding)})`);

  const width = num(node.props.frameWidth);
  const height = num(node.props.frameHeight);
  if (width !== null || height !== null) {
    const args: string[] = [];
    if (width !== null) args.push(`width: ${swiftNumber(width)}`);
    if (height !== null) args.push(`height: ${swiftNumber(height)}`);
    lines.push(`.frame(${args.join(", ")})`);
  }

  const background = swiftColor(str(node.props.background));
  if (background) lines.push(`.background(${background})`);

  const cornerRadius = num(node.props.cornerRadius);
  if (cornerRadius !== null && cornerRadius > 0) {
    lines.push(`.clipShape(RoundedRectangle(cornerRadius: ${swiftNumber(cornerRadius)}))`);
  }

  const opacity = num(node.props.opacity);
  if (opacity !== null) lines.push(`.opacity(${swiftNumber(opacity)})`);

  return lines;
}

/** `@State` declarations required by every bound control in the tree. */
export function stateDeclarations(root: UINode): string[] {
  const seen = new Map<string, StateValueType>();
  const visit = (node: UINode) => {
    const spec = CATALOG[node.kind];
    if (spec) {
      for (const field of spec.fields) {
        if (field.type !== "state") continue;
        const name = swiftIdentifier(str(node.props[field.key]));
        if (name && !seen.has(name)) seen.set(name, field.valueType);
      }
    }
    node.children.forEach(visit);
  };
  visit(root);

  return [...seen.entries()].map(([name, valueType]) => {
    const value = STATE_DEFAULTS[valueType];
    const type = valueType === "Bool" ? "" : `: ${valueType}`;
    return `@State private var ${name}${type} = ${value}`;
  });
}

// ----------------------------------------------------------- preview styles --

const CSS_COLORS: Record<string, string> = {
  primary: "#1c1c1e",
  secondary: "#6e6e73",
  red: "#ff3b30",
  orange: "#ff9500",
  yellow: "#ffcc00",
  green: "#34c759",
  mint: "#00c7be",
  teal: "#30b0c7",
  cyan: "#32ade6",
  blue: "#007aff",
  indigo: "#5856d6",
  purple: "#af52de",
  pink: "#ff2d55",
  brown: "#a2845e",
  white: "#ffffff",
  black: "#000000",
  gray: "#8e8e93",
  clear: "transparent",
};

const CSS_FONT_SIZES: Record<string, string> = {
  largeTitle: "34px",
  title: "28px",
  title2: "22px",
  title3: "20px",
  headline: "17px",
  subheadline: "15px",
  body: "17px",
  callout: "16px",
  footnote: "13px",
  caption: "12px",
  caption2: "11px",
};

const CSS_WEIGHTS: Record<string, number> = {
  ultraLight: 100,
  thin: 200,
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  heavy: 800,
  black: 900,
};

function cssColor(value: string): string | undefined {
  const parsed = parseColor(value);
  if (!parsed) return undefined;
  if (parsed.kind === "named") return CSS_COLORS[parsed.name];
  return `rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`;
}

/** Text-ish modifiers (font, weight, colour); specs apply these themselves. */
export function textCss(node: UINode): CSSProperties {
  const style: CSSProperties = {};

  const font = str(node.props.font).replace(/^\./, "");
  if (font && CSS_FONT_SIZES[font]) {
    style.fontSize = CSS_FONT_SIZES[font];
    style.fontWeight = font === "headline" ? 600 : undefined;
  }

  const weight = CSS_WEIGHTS[str(node.props.weight).replace(/^\./, "")];
  if (weight) style.fontWeight = weight;

  const foreground = cssColor(str(node.props.foreground));
  if (foreground) style.color = foreground;

  return style;
}

/** Box modifiers (padding, frame, background, radius, opacity): the canvas
 * wrapper applies these once per node. */
export function boxCss(node: UINode): CSSProperties {
  const style: CSSProperties = {};

  const padding = num(node.props.padding);
  if (padding !== null) style.padding = `${padding}px`;

  const width = num(node.props.frameWidth);
  const height = num(node.props.frameHeight);
  if (width !== null) {
    style.width = `${width}px`;
    style.flex = "none";
  }
  if (height !== null) style.height = `${height}px`;

  const background = cssColor(str(node.props.background));
  if (background) style.background = background;

  const cornerRadius = num(node.props.cornerRadius);
  if (cornerRadius !== null && cornerRadius > 0) {
    style.borderRadius = `${cornerRadius}px`;
    style.overflow = "hidden";
  }

  const opacity = num(node.props.opacity);
  if (opacity !== null) style.opacity = opacity;

  return style;
}

function alignToCss(value: string): "flex-start" | "center" | "flex-end" | undefined {
  if (value === "leading" || value === "topLeading") return "flex-start";
  if (value === "center" || value === "top" || value === "bottom") return "center";
  if (value === "trailing" || value === "bottomTrailing") return "flex-end";
  return undefined;
}

function textStyle(node: UINode): CSSProperties {
  return { fontSize: 17, color: "#1c1c1e", ...textCss(node) };
}

const SYMBOL_BOX: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 6,
  background: "#f2f2f7",
  border: "1px dashed #b8b8bf",
  fontSize: 11,
  color: "#6e6e73",
};

// ----------------------------------------------------------------- catalogue --

const CATALOG_LIST: Spec[] = [
  // ---------------------------------------------------------------- layout --
  {
    kind: "VStack",
    label: "VStack",
    category: "Layout",
    container: true,
    summary: "Vertical stack",
    defaults: { alignment: "center", spacing: "8" },
    fields: [
      {
        key: "alignment",
        label: "Alignment",
        type: "enum",
        options: ["", "leading", "center", "trailing"],
      },
      { key: "spacing", label: "Spacing", type: "number", placeholder: "8" },
    ],
    swift: (node) => {
      const args: string[] = [];
      const alignment = str(node.props.alignment);
      if (alignment) args.push(`alignment: .${alignment}`);
      const spacing = num(node.props.spacing);
      if (spacing !== null) args.push(`spacing: ${swiftNumber(spacing)}`);
      return [`VStack${args.length ? `(${args.join(", ")})` : ""} {`];
    },
    preview: (node, children) => (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: alignToCss(str(node.props.alignment)) ?? "center",
          gap: num(node.props.spacing) ?? 0,
        }}
      >
        {children}
      </div>
    ),
  },
  {
    kind: "HStack",
    label: "HStack",
    category: "Layout",
    container: true,
    summary: "Horizontal stack",
    defaults: { alignment: "center", spacing: "8" },
    fields: [
      {
        key: "alignment",
        label: "Alignment",
        type: "enum",
        options: ["", "top", "center", "bottom"],
      },
      { key: "spacing", label: "Spacing", type: "number", placeholder: "8" },
    ],
    swift: (node) => {
      const args: string[] = [];
      const alignment = str(node.props.alignment);
      if (alignment) args.push(`alignment: .${alignment}`);
      const spacing = num(node.props.spacing);
      if (spacing !== null) args.push(`spacing: ${swiftNumber(spacing)}`);
      return [`HStack${args.length ? `(${args.join(", ")})` : ""} {`];
    },
    preview: (node, children) => (
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems:
            str(node.props.alignment) === "bottom"
              ? "flex-end"
              : alignToCss(str(node.props.alignment)) ?? "center",
          gap: num(node.props.spacing) ?? 0,
        }}
      >
        {children}
      </div>
    ),
  },
  {
    kind: "ZStack",
    label: "ZStack",
    category: "Layout",
    container: true,
    summary: "Layered stack",
    defaults: {},
    fields: [],
    swift: () => ["ZStack {"],
    preview: (_node, children) => (
      <div style={{ display: "grid", placeItems: "center" }}>
        {Array.isArray(children)
          ? children.map((child, index) => (
              <div key={index} style={{ gridArea: "1 / 1" }}>
                {child}
              </div>
            ))
          : children}
      </div>
    ),
  },
  {
    kind: "ScrollView",
    label: "ScrollView",
    category: "Layout",
    container: true,
    summary: "Scrollable container",
    defaults: { axis: "vertical" },
    fields: [
      {
        key: "axis",
        label: "Axis",
        type: "enum",
        options: ["vertical", "horizontal"],
      },
    ],
    swift: (node) =>
      str(node.props.axis) === "horizontal"
        ? ["ScrollView(.horizontal) {"]
        : ["ScrollView {"],
    preview: (node, children) => (
      <div
        style={{
          display: "flex",
          flexDirection: str(node.props.axis) === "horizontal" ? "row" : "column",
          gap: 8,
          overflow: "auto",
          maxWidth: "100%",
          maxHeight: 260,
          padding: 4,
          border: "1px dashed #d0d0d6",
          borderRadius: 8,
        }}
      >
        {children}
      </div>
    ),
  },
  {
    kind: "List",
    label: "List",
    category: "Layout",
    container: true,
    summary: "System list",
    defaults: {},
    fields: [],
    swift: () => ["List {"],
    preview: (_node, children) => (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", background: "#fff" }}>
        {children}
      </div>
    ),
  },
  {
    kind: "Form",
    label: "Form",
    category: "Layout",
    container: true,
    summary: "Grouped settings form",
    defaults: {},
    fields: [],
    swift: () => ["Form {"],
    preview: (_node, children) => (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          width: "100%",
          background: "#f2f2f7",
          borderRadius: 10,
          padding: 8,
        }}
      >
        {children}
      </div>
    ),
  },
  {
    kind: "Group",
    label: "Group",
    category: "Layout",
    container: true,
    summary: "Applies modifiers to several views",
    defaults: {},
    fields: [],
    swift: () => ["Group {"],
    preview: (_node, children) => (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    ),
  },
  {
    kind: "Section",
    label: "Section",
    category: "Layout",
    container: true,
    summary: "Section inside List or Form",
    defaults: { header: "Section" },
    fields: [{ key: "header", label: "Header", type: "string", placeholder: "Section" }],
    swift: (node) => {
      const header = str(node.props.header);
      return [header ? `Section(${swiftString(header)}) {` : "Section {"];
    },
    preview: (node, children) => (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
        <div style={{ fontSize: 12, color: "#6e6e73", textTransform: "uppercase" }}>
          {str(node.props.header)}
        </div>
        {children}
      </div>
    ),
  },
  {
    kind: "NavigationStack",
    label: "NavigationStack",
    category: "Layout",
    container: true,
    summary: "Navigation container with a title",
    defaults: { title: "Title" },
    fields: [{ key: "title", label: "Title", type: "string", placeholder: "Title" }],
    swift: () => ["NavigationStack {"],
    childModifiers: (children, node) => {
      const title = str(node.props.title);
      if (!title) return children;
      const modifier = `.navigationTitle(${swiftString(title)})`;
      if (children.length === 1) {
        return [appendModifier(children[0], modifier)];
      }
      // navigationTitle has to be applied to a single view, so wrap the rest
      const wrapped = ["Group {", ...children.flatMap((c) => indentLines(c, 1)), "}"];
      return [appendModifier(wrapped, modifier)];
    },
    preview: (node, children) => (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "6px 8px",
            borderBottom: "1px solid #e0e0e5",
            fontSize: 15,
            fontWeight: 600,
            color: "#1c1c1e",
          }}
        >
          {str(node.props.title) || "Title"}
        </div>
        {children}
      </div>
    ),
  },
  {
    kind: "Spacer",
    label: "Spacer",
    category: "Layout",
    container: false,
    summary: "Flexible space",
    defaults: {},
    fields: [],
    swift: () => ["Spacer()"],
    preview: () => (
      <div
        style={{
          flex: "1 1 24px",
          minWidth: 24,
          minHeight: 12,
          border: "1px dashed #d0d0d6",
          borderRadius: 4,
          background:
            "repeating-linear-gradient(45deg, #fafafa, #fafafa 4px, #f0f0f2 4px, #f0f0f2 8px)",
        }}
      />
    ),
  },
  {
    kind: "Divider",
    label: "Divider",
    category: "Layout",
    container: false,
    summary: "Horizontal rule",
    defaults: {},
    fields: [],
    swift: () => ["Divider()"],
    preview: () => <div style={{ height: 1, width: "100%", background: "#e0e0e5" }} />,
  },
  // ------------------------------------------------------------------ text --
  {
    kind: "Text",
    label: "Text",
    category: "Text",
    container: false,
    summary: "Static text",
    defaults: { text: "Hello, world!" },
    fields: [{ key: "text", label: "Text", type: "string", placeholder: "Hello" }],
    swift: (node) => [`Text(${swiftString(str(node.props.text))})`],
    preview: (node) => <span style={textStyle(node)}>{str(node.props.text)}</span>,
  },
  {
    kind: "Label",
    label: "Label",
    category: "Text",
    container: false,
    summary: "Icon + title pair",
    defaults: { title: "Settings", systemImage: "gearshape" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Settings" },
      { key: "systemImage", label: "SF Symbol", type: "string", placeholder: "gearshape" },
    ],
    swift: (node) => [
      `Label(${swiftString(str(node.props.title))}, systemImage: ${swiftString(
        str(node.props.systemImage)
      )})`,
    ],
    preview: (node) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...textStyle(node) }}>
        <span style={SYMBOL_BOX}>{str(node.props.systemImage) || "symbol"}</span>
        {str(node.props.title)}
      </span>
    ),
  },
  // -------------------------------------------------------------- controls --
  {
    kind: "Button",
    label: "Button",
    category: "Controls",
    container: false,
    summary: "Tappable button",
    defaults: { title: "Continue", systemImage: "", style: "" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Continue" },
      { key: "systemImage", label: "SF Symbol", type: "string", placeholder: "(optional)" },
      {
        key: "style",
        label: "Style",
        type: "enum",
        options: ["", "bordered", "borderedProminent", "plain"],
      },
    ],
    swift: (node) => {
      const title = str(node.props.title) || "Button";
      const symbol = str(node.props.systemImage);
      const lines = symbol
        ? [
            "Button {",
            `${INDENT}// TODO: handle tap`,
            "} label: {",
            `${INDENT}Label(${swiftString(title)}, systemImage: ${swiftString(symbol)})`,
            "}",
          ]
        : [`Button(${swiftString(title)}) {`, `${INDENT}// TODO: handle tap`, "}"];
      const style = str(node.props.style);
      // a trailing-closure block keeps its modifiers aligned with the block
      return style ? appendModifier(lines, `.buttonStyle(.${style})`) : lines;
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px",
          borderRadius: 10,
          background:
            str(node.props.style) === "borderedProminent" ? "#007aff" : "#f2f2f7",
          color: str(node.props.style) === "borderedProminent" ? "#fff" : "#007aff",
          fontSize: 15,
          fontWeight: 500,
          ...textCss(node),
        }}
      >
        {str(node.props.systemImage) && (
          <span style={{ ...SYMBOL_BOX, background: "transparent", border: "none", padding: 0 }}>
            {str(node.props.systemImage)}
          </span>
        )}
        {str(node.props.title)}
      </span>
    ),
  },
  {
    kind: "Toggle",
    label: "Toggle",
    category: "Controls",
    container: false,
    summary: "On/off switch bound to @State",
    defaults: { title: "Enabled", isOn: "isEnabled" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Enabled" },
      { key: "isOn", label: "Bound to", type: "state", valueType: "Bool" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.isOn)) || "isEnabled";
      return [`Toggle(${swiftString(str(node.props.title))}, isOn: $${name})`];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          ...textStyle(node),
        }}
      >
        <span>{str(node.props.title)}</span>
        <span
          style={{
            width: 42,
            height: 26,
            borderRadius: 13,
            background: "#34c759",
            position: "relative",
            flex: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 22,
              height: 22,
              borderRadius: 11,
              background: "#fff",
            }}
          />
        </span>
      </span>
    ),
  },
  {
    kind: "TextField",
    label: "TextField",
    category: "Controls",
    container: false,
    summary: "Text input bound to @State",
    defaults: { placeholder: "Name", text: "name" },
    fields: [
      { key: "placeholder", label: "Placeholder", type: "string", placeholder: "Name" },
      { key: "text", label: "Bound to", type: "state", valueType: "String" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.text)) || "text";
      return [
        `TextField(${swiftString(str(node.props.placeholder))}, text: $${name})`,
        `${INDENT}.textFieldStyle(.roundedBorder)`,
      ];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          width: "100%",
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid #d0d0d6",
          background: "#fff",
          color: "#8e8e93",
          ...textCss(node),
        }}
      >
        {str(node.props.placeholder)}
      </span>
    ),
  },
  {
    kind: "SecureField",
    label: "SecureField",
    category: "Controls",
    container: false,
    summary: "Password input bound to @State",
    defaults: { placeholder: "Password", text: "password" },
    fields: [
      { key: "placeholder", label: "Placeholder", type: "string", placeholder: "Password" },
      { key: "text", label: "Bound to", type: "state", valueType: "String" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.text)) || "password";
      return [`SecureField(${swiftString(str(node.props.placeholder))}, text: $${name})`];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          width: "100%",
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid #d0d0d6",
          background: "#fff",
          color: "#8e8e93",
          ...textCss(node),
        }}
      >
        ••••••••
      </span>
    ),
  },
  {
    kind: "Slider",
    label: "Slider",
    category: "Controls",
    container: false,
    summary: "Continuous value bound to @State",
    defaults: { value: "volume", min: "0", max: "1" },
    fields: [
      { key: "value", label: "Bound to", type: "state", valueType: "Double" },
      { key: "min", label: "Minimum", type: "number", placeholder: "0" },
      { key: "max", label: "Maximum", type: "number", placeholder: "1" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.value)) || "value";
      const min = num(node.props.min);
      const max = num(node.props.max);
      const range =
        min !== null && max !== null ? `, in: ${swiftNumber(min)}...${swiftNumber(max)}` : "";
      return [`Slider(value: $${name}${range})`];
    },
    preview: () => (
      <div style={{ display: "flex", alignItems: "center", width: "100%", padding: "6px 0" }}>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: "#e0e0e5" }}>
          <div style={{ width: "40%", height: 4, borderRadius: 2, background: "#007aff" }} />
        </div>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: "#fff",
            border: "1px solid #d0d0d6",
            marginLeft: -10,
          }}
        />
      </div>
    ),
  },
  {
    kind: "Stepper",
    label: "Stepper",
    category: "Controls",
    container: false,
    summary: "Increment/decrement bound to @State",
    defaults: { title: "Count", value: "count" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Count" },
      { key: "value", label: "Bound to", type: "state", valueType: "Int" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.value)) || "count";
      return [`Stepper(${swiftString(str(node.props.title))}, value: $${name})`];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          ...textStyle(node),
        }}
      >
        <span>{str(node.props.title)}</span>
        <span
          style={{
            display: "inline-flex",
            width: 90,
            border: "1px solid #d0d0d6",
            borderRadius: 8,
            overflow: "hidden",
            fontSize: 15,
          }}
        >
          <span style={{ flex: 1, textAlign: "center" }}>−</span>
          <span style={{ width: 1, background: "#d0d0d6" }} />
          <span style={{ flex: 1, textAlign: "center" }}>+</span>
        </span>
      </span>
    ),
  },
  {
    kind: "Picker",
    label: "Picker",
    category: "Controls",
    container: false,
    summary: "Choice list bound to @State",
    defaults: { title: "Size", selection: "size", options: "Small, Medium, Large" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Size" },
      { key: "selection", label: "Bound to", type: "state", valueType: "String" },
      { key: "options", label: "Options", type: "string", placeholder: "A, B, C" },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.selection)) || "selection";
      const options = csv(node.props.options);
      const rows = (options.length > 0 ? options : ["One"]).map(
        (option) => `${INDENT}Text(${swiftString(option)}).tag(${swiftString(option)})`
      );
      return [
        `Picker(${swiftString(str(node.props.title))}, selection: $${name}) {`,
        ...rows,
        "}",
      ];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          ...textStyle(node),
        }}
      >
        <span>{str(node.props.title)}</span>
        <span style={{ color: "#007aff", fontSize: 15 }}>
          {(csv(node.props.options)[0] ?? "One")} ▾
        </span>
      </span>
    ),
  },
  {
    kind: "DatePicker",
    label: "DatePicker",
    category: "Controls",
    container: false,
    summary: "Date selection bound to @State",
    defaults: { title: "Date", selection: "date", components: "date" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "Date" },
      { key: "selection", label: "Bound to", type: "state", valueType: "Date" },
      {
        key: "components",
        label: "Components",
        type: "enum",
        options: ["date", "hourAndMinute", "dateAndTime"],
      },
    ],
    swift: (node) => {
      const name = swiftIdentifier(str(node.props.selection)) || "date";
      const components = str(node.props.components);
      const suffix = components ? `, displayedComponents: .${components}` : "";
      return [`DatePicker(${swiftString(str(node.props.title))}, selection: $${name}${suffix})`];
    },
    preview: (node) => (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          ...textStyle(node),
        }}
      >
        <span>{str(node.props.title)}</span>
        <span style={{ color: "#6e6e73", fontSize: 15 }}>2026-09-24</span>
      </span>
    ),
  },
  {
    kind: "ProgressView",
    label: "ProgressView",
    category: "Controls",
    container: false,
    summary: "Progress indicator",
    defaults: { title: "", value: "0.5" },
    fields: [
      { key: "title", label: "Title", type: "string", placeholder: "(optional)" },
      { key: "value", label: "Value (0-1)", type: "number", placeholder: "0.5" },
    ],
    swift: (node) => {
      const title = str(node.props.title);
      const value = num(node.props.value);
      const label = title ? `${swiftString(title)}, ` : "";
      if (value === null) {
        return [title ? `ProgressView(${swiftString(title)})` : "ProgressView()"];
      }
      return [`ProgressView(${label}value: ${swiftNumber(value)})`];
    },
    preview: (node) => (
      <span style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
        {str(node.props.title) && <span style={{ fontSize: 13 }}>{str(node.props.title)}</span>}
        <span style={{ height: 6, borderRadius: 3, background: "#e0e0e5", display: "block" }}>
          <span
            style={{
              display: "block",
              width: `${Math.max(0, Math.min(1, num(node.props.value) ?? 0)) * 100}%`,
              height: 6,
              borderRadius: 3,
              background: "#007aff",
            }}
          />
        </span>
      </span>
    ),
  },
  // ----------------------------------------------------------------- media --
  {
    kind: "Image",
    label: "Image",
    category: "Media",
    container: false,
    summary: "SF Symbol or asset image",
    defaults: { source: "symbol", name: "photo", resizable: false },
    fields: [
      { key: "source", label: "Source", type: "enum", options: ["symbol", "asset"] },
      { key: "name", label: "Name", type: "string", placeholder: "photo" },
      { key: "resizable", label: "Resizable", type: "bool" },
    ],
    swift: (node) => {
      const name = str(node.props.name) || "photo";
      const expression =
        str(node.props.source) === "asset"
          ? `Image(${swiftString(name)})`
          : `Image(systemName: ${swiftString(name)})`;
      const lines = [expression];
      if (bool(node.props.resizable)) {
        lines.push(`${INDENT}.resizable()`);
        lines.push(`${INDENT}.aspectRatio(contentMode: .fit)`);
      }
      return lines;
    },
    preview: (node) => (
      <span style={{ display: "inline-flex", ...textCss(node) }}>
        <span style={SYMBOL_BOX}>
          {str(node.props.source) === "asset" ? "asset" : "SF"}: {str(node.props.name) || "photo"}
        </span>
      </span>
    ),
  },
];

export const CATALOG: Record<string, Spec> = Object.fromEntries(
  CATALOG_LIST.map((spec) => [spec.kind, spec])
);

export const PALETTE: Spec[] = CATALOG_LIST;

export function fieldsOf(node: UINode): PropField[] {
  const spec = CATALOG[node.kind];
  if (!spec) return [];
  return [...spec.fields, ...MODIFIER_FIELDS];
}

/** A fresh node of `kind`, including its default props. */
export function defaultsFor(kind: string): Props {
  const spec = CATALOG[kind];
  return spec ? { ...spec.defaults } : {};
}
