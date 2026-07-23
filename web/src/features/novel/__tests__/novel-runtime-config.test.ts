import { describe, expect, it } from "vitest";
import { applyRuntimeEnvDefaults } from "../../../../scripts/novel-runtime";

describe("novel runtime environment defaults", () => {
  it("uses the project-local browser default when the runtime key is absent", () => {
    const target: NodeJS.ProcessEnv = {};

    applyRuntimeEnvDefaults(target, {
      VITE_DEFAULT_API_KEY: "  local-tool-key  ",
      VITE_DEFAULT_API_BASE_URL: " https://example.test/v1 ",
    });

    expect(target.YMCP_API_KEY).toBe("local-tool-key");
    expect(target.YMCP_API_BASE_URL).toBe("https://example.test/v1");
  });

  it("keeps explicit runtime configuration ahead of file defaults", () => {
    const target: NodeJS.ProcessEnv = {
      YMCP_API_KEY: "runtime-key",
      YMCP_API_BASE_URL: "https://runtime.test/v1",
    };

    applyRuntimeEnvDefaults(target, {
      VITE_DEFAULT_API_KEY: "file-key",
      VITE_DEFAULT_API_BASE_URL: "https://file.test/v1",
    });

    expect(target.YMCP_API_KEY).toBe("runtime-key");
    expect(target.YMCP_API_BASE_URL).toBe("https://runtime.test/v1");
  });
});
