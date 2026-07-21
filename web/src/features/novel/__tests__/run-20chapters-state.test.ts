import { describe, expect, it } from "vitest";
import {
  assertCheckpointMatchesProgress,
  chapterAttemptPassed,
  resolve20ChapterRunDir,
  type RunCheckpoint,
} from "../../../../scripts/novel-bench/run-20chapters-impl";

function checkpointWithDocument(status: string | undefined): RunCheckpoint {
  const projectId = "project-1";
  const chapterId = "chapter-1";
  const snapshotHash = "snapshot-hash";
  const document = status === undefined ? [] : [{ id: chapterId, projectId, status }];
  return {
    format: "ymcp-novel-20chapters-checkpoint",
    formatVersion: 1,
    progress: {
      startedAt: 1,
      updatedAt: 2,
      projectId,
      qualityThreshold: 3.7,
      dryRun: false,
      completedChapters: [{
        chapterNumber: 1,
        chapterId,
        threadId: "thread-1",
        briefId: "brief-1",
        phaseIndex: 0,
        attempts: 1,
        promoted: true,
        finalReceiptStatus: "promoted",
        finalWeightedScore: 4,
        finalQualityDimensions: {},
        finalWordCount: 3000,
        workflowRunIds: ["run-1"],
        canonicalHashBefore: "before",
        canonicalHashAfter: snapshotHash,
        completedAt: 2,
      }],
      failureLog: [],
    },
    fixture: {
      format: "ymcp-novel-closed-loop",
      formatVersion: 1,
      conversationThreads: [],
      creativeBriefs: [],
      snapshot: {
        sourceProjectId: projectId,
        records: { documents: document },
        manifest: { snapshotHash },
      },
    } as unknown as RunCheckpoint["fixture"],
  };
}

describe("20 chapter runner state guards", () => {
  it("uses a stable default directory for the same resumable run", () => {
    const input = { seed: "F:/fixtures/story.json", maxChapters: 20, startChapter: 1, endChapter: 20, dryRun: false };
    const first = resolve20ChapterRunDir(input);
    const second = resolve20ChapterRunDir(input);
    expect(first).toBe(second);
    expect(first).toContain("20chapters-");
  });

  it("treats a ready, above-threshold dry-run as successful without promotion", () => {
    expect(chapterAttemptPassed({
      dryRun: true,
      promoted: false,
      inspectStatus: "ready",
      score: 3.8,
      qualityThreshold: 3.7,
    })).toBe(true);
    expect(chapterAttemptPassed({
      dryRun: false,
      promoted: false,
      inspectStatus: "ready",
      score: 3.8,
      qualityThreshold: 3.7,
    })).toBe(false);
  });

  it("rejects resume checkpoints that skip a missing or non-final completed chapter", () => {
    expect(() => assertCheckpointMatchesProgress(checkpointWithDocument(undefined))).toThrow(/缺少已完成章节/);
    expect(() => assertCheckpointMatchesProgress(checkpointWithDocument("draft"))).toThrow(/不是 final/);
    expect(() => assertCheckpointMatchesProgress(checkpointWithDocument("final"))).not.toThrow();
  });
});
