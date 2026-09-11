/**
 * Minimal ambient types for the parts of `bun:test` used by tests that must
 * run under `bun test` (the project gate runner).
 *
 * tests/authorization/require-org.test.ts mocks modules with Bun's
 * `mock.module()` — `vi.mock` is silently ignored by bun's runner, and bun has
 * no `bun-types` dependency installed, so this declaration keeps
 * `bun run typecheck` green without adding a dependency.
 *
 * Replace this file with the full `bun-types` / `@types/bun` package if that
 * dependency is ever added to the project.
 */
declare module "bun:test" {
  export function describe(name: string, factory: () => void): void;
  export function it(name: string, factory: () => unknown): void;
  export function beforeEach(factory: () => unknown): void;
  export const expect: (actual: unknown) => any;
  export const mock: {
    /** Replace a module's exports for every importer in this test file. */
    module(specifier: string, factory: () => unknown): void;
  };
}
