import { defineConfig } from "vitest/config";

const live = process.env.STACKPRINT_LIVE === "1";

export default defineConfig({
  test: {
    include: live ? ["test/**/*.test.ts"] : ["test/unit/**/*.test.ts"],
    testTimeout: live ? 60_000 : 10_000,
  },
});
