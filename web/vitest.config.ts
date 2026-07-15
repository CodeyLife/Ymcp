import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/features/novel/__tests__/setup.ts"],
    include: [
      "src/features/novel/**/__tests__/*.test.{ts,tsx}",
      "src/lib/**/__tests__/*.test.{ts,tsx}",
      "src/shared/**/__tests__/*.test.{ts,tsx}",
    ],
  },
});
