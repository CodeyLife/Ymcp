import { describe, expect, it } from "vitest";
import { migratePersistedUIState } from "../ui";

describe("UI state migrations", () => {
  it("preserves explicit model choices while filling a missing model", () => {
    expect(migratePersistedUIState({ chatModel: "auto" }, 4).chatModel).toBe("auto");
    expect(migratePersistedUIState({ chatModel: "provider-model" }, 4).chatModel).toBe("provider-model");
    expect(migratePersistedUIState({}, 4).chatModel).toBe("gpt-5-5");
  });
});
