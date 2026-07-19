import { describe, expect, it } from "vitest";
import { getEffectiveApiConfig, migratePersistedUIState, useUIStore } from "../ui";

describe("UI state migrations", () => {
  it("preserves explicit model choices while filling a missing model", () => {
    expect(migratePersistedUIState({ chatModel: "auto" }, 4).chatModel).toBe("auto");
    expect(migratePersistedUIState({ chatModel: "provider-model" }, 4).chatModel).toBe("provider-model");
    expect(migratePersistedUIState({}, 4).chatModel).toBe("gpt-5-5");
  });

  it("does not treat a missing deployment key as configured", () => {
    useUIStore.setState({ apiBaseUrl: "", apiKey: "" });
    const config = getEffectiveApiConfig();

    expect(config.apiKey).toBe("");
    expect(config.hasOwnKey).toBe(false);
    expect(config.hasDefaultKey).toBe(false);
    expect(config.hasEffectiveKey).toBe(false);
    expect(config.usesDefaultBaseUrl).toBe(true);
  });

  it("uses a trimmed user key for custom endpoints", () => {
    useUIStore.setState({ apiBaseUrl: "https://example.test/v1/", apiKey: "  user-key  " });
    const config = getEffectiveApiConfig();

    expect(config.baseUrl).toBe("https://example.test/v1");
    expect(config.apiKey).toBe("user-key");
    expect(config.hasOwnKey).toBe(true);
    expect(config.hasEffectiveKey).toBe(true);
    expect(config.usesDefaultBaseUrl).toBe(false);
  });
});
