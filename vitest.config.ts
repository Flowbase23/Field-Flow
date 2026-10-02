import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    // tests/authorization/require-org.test.ts,
    // tests/authorization/invoice-actions.test.ts,
    // tests/authorization/estimate-actions.test.ts,
    // tests/authorization/payment-actions.test.ts and
    // tests/stripe-webhook.test.ts use bun:test `mock.module()`
    // — bun's runner ignores vi.mock, and vitest cannot resolve bun:test. The
    // project test gate is `bun test`, which runs those files; they are excluded
    // here so `vitest run` (bun run test) stays green.
    exclude: ["**/node_modules/**", "tests/authorization/require-org.test.ts", "tests/authorization/invoice-actions.test.ts", "tests/authorization/estimate-actions.test.ts", "tests/authorization/payment-actions.test.ts", "tests/stripe-webhook.test.ts"],
  },
});
