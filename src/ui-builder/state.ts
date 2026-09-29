// The Swift types a builder control can bind to.
//
// Lives on its own (no JSX, no catalog) so the action helpers can use it
// without pulling the component catalog in.

export type StateValueType = "Bool" | "String" | "Double" | "Int" | "Date";

/** Initial value of a freshly declared `@State` variable. */
export const STATE_DEFAULTS: Record<StateValueType, string> = {
  Bool: "false",
  String: '""',
  Double: "0",
  Int: "0",
  Date: "Date()",
};
