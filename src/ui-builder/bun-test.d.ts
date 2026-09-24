// Minimal ambient types for bun's built-in test runner.
//
// The tests in this folder are executed with `bun test` (see the CI workflow),
// but the project does not depend on `@types/bun`, so declare the small subset
// of the API the tests use instead of pulling in another dependency.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;

  interface Matchers {
    toBe(expected: unknown): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    not: {
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
      toEqual(expected: unknown): void;
    };
  }

  export function expect(actual: unknown): Matchers;
}
