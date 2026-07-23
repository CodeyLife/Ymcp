import { describe, expect, it } from "vitest";
import { assertProposalReferences, emptyReferenceCatalog, repairProposalCharacterReferences } from "../reference-integrity";
import type { ProposalItem } from "../types";

function relation(payload: Record<string, unknown>, label = "甲与乙的关系"): ProposalItem {
  return { id: "relation", label, operation: "create", targetTable: "relations", status: "pending", payload, rationale: "两人形成复杂合作", dependencies: [] };
}

describe("relation reference integrity", () => {
  it("repairs an invalid relation endpoint from the two names in its label", () => {
    const catalog = emptyReferenceCatalog();
    catalog.entityIds = new Set(["character-a", "character-b"]);
    catalog.characterIds = new Set(["character-a", "character-b"]);
    const items = [relation({ fromEntityId: "character-a", toEntityId: "near-miss-id" }, "甲与乙的关系")];

    const result = repairProposalCharacterReferences(items, catalog, new Map([["甲", "character-a"], ["乙", "character-b"]]));

    expect(result.repaired).toBe(1);
    expect(items[0].payload.toEntityId).toBe("character-b");
    expect(() => assertProposalReferences(items, catalog)).not.toThrow();
  });

  it("rejects an invalid endpoint when no unique named entity can repair it", () => {
    const catalog = emptyReferenceCatalog();
    catalog.entityIds.add("character-a");
    const items = [relation({ fromEntityId: "character-a", toEntityId: "invented-id" }, "一段未指明对象的关系")];

    expect(() => assertProposalReferences(items, catalog)).toThrow(/toEntityId.*invented-id/);
  });
});

describe("plot-thread participant integrity", () => {
  it("drops non-character entities without duplicating the first named character", () => {
    const catalog = emptyReferenceCatalog();
    catalog.entityIds = new Set(["character-a", "character-b", "location-a", "organization-a"]);
    catalog.characterIds = new Set(["character-a", "character-b"]);
    const item: ProposalItem = {
      id: "thread",
      label: "甲乙共同调查",
      operation: "create",
      targetTable: "plotThreads",
      status: "pending",
      payload: {
        kind: "main",
        title: "甲乙共同调查",
        summary: "甲与乙从不同立场追查同一条资源链。",
        participantIds: ["character-a", "location-a", "organization-a"],
      },
      rationale: "让甲与乙共同承担选择",
      dependencies: [],
    };

    repairProposalCharacterReferences([item], catalog, new Map([["甲", "character-a"], ["乙", "character-b"]]));

    expect(item.payload.participantIds).toEqual(["character-a", "character-b"]);
    expect(() => assertProposalReferences([item], catalog)).not.toThrow();
  });

  it("rejects a plot thread whose participant set is empty after repair", () => {
    const catalog = emptyReferenceCatalog();
    catalog.entityIds.add("location-a");
    const item: ProposalItem = {
      id: "thread",
      label: "无名共谋",
      operation: "create",
      targetTable: "plotThreads",
      status: "pending",
      payload: { kind: "conspiracy", title: "无名共谋", summary: "若干势力暗中行动。", participantIds: ["location-a"] },
      rationale: "隐藏行动",
      dependencies: [],
    };

    repairProposalCharacterReferences([item], catalog, new Map());

    expect(item.payload.participantIds).toEqual([]);
    expect(() => assertProposalReferences([item], catalog)).toThrow(/至少包含 1 个真实角色 ID/);
  });

  it("allows a partial plot-thread update to inherit existing participants", () => {
    const catalog = emptyReferenceCatalog();
    const item: ProposalItem = {
      id: "thread-update",
      label: "推进剧情线",
      operation: "update",
      targetTable: "plotThreads",
      targetId: "existing-thread",
      status: "pending",
      payload: { progress: 20, nextMove: "进入下一阶段" },
      rationale: "同步进度",
      dependencies: [],
    };

    expect(() => assertProposalReferences([item], catalog)).not.toThrow();
    item.payload.participantIds = [];
    expect(() => assertProposalReferences([item], catalog)).toThrow(/至少包含 1 个真实角色 ID/);
  });
});
