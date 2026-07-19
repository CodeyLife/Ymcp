import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ===== Mocks =====

const { useClosedLoopMock } = vi.hoisted(() => ({
  useClosedLoopMock: vi.fn(),
}));

vi.mock("../evaluation/useClosedLoop", () => ({
  useClosedLoop: useClosedLoopMock,
}));

vi.mock("../db", () => ({
  novelDb: {},
}));

vi.mock("../AIWorkbench", () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    `<div class="markdown-stub">${content}</div>` as unknown as ReactNode,
}));

import { ClosedLoopPanel, ClosedLoopResultContent } from "../evaluation/ClosedLoopPanel";
import type { ClosedLoopResult } from "../evaluation/closed-loop";
import type { CreativeBrief, ManuscriptDocument, NovelConversationThread } from "../types";
import type { UseClosedLoopResult } from "../evaluation/useClosedLoop";

// ===== Fixtures =====

// Fixtures use `as unknown as` casting because the full type definitions include many
// nested fields (ChapterBlueprint, etc.) that aren't relevant to the UI panel rendering.
const document = {
  id: "doc-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  order: 0,
  title: "第一章",
  contentHtml: "",
  plainText: "",
  wordCount: 0,
  status: "draft",
  blueprint: { beats: [] },
  summary: "",
  branch: "main",
  yjsDocumentId: "yjs-1",
} as unknown as ManuscriptDocument;

const conversationThread = {
  id: "thread-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  taskKey: "chapter-collaboration" as const,
  targetId: "doc-1",
  title: "第一章协作",
  summary: "",
  status: "active",
  pinnedSourceIds: [],
  excludedSourceIds: [],
  lastMessageAt: 0,
} as unknown as NovelConversationThread;

const confirmedBrief = {
  id: "brief-1",
  projectId: "p1",
  schemaVersion: 4,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  createdBy: "test",
  updatedBy: "test",
  threadId: "thread-1",
  targetDocumentId: "doc-1",
  goal: "完成第一章",
  status: "confirmed",
  tone: "",
  languageRequirements: [],
  mustHappen: [],
  forbidden: [],
  targetWords: 0,
  referencedMemoryIds: [],
  openQuestions: [],
  sourceMessageIds: [],
} as unknown as CreativeBrief;

const draftBrief = { ...confirmedBrief, status: "draft" } as unknown as CreativeBrief;

function makeClosedLoopResult(overrides?: Partial<ClosedLoopResult>): ClosedLoopResult {
  return {
    experimentId: "exp-1",
    experimentWorkspace: {} as ClosedLoopResult["experimentWorkspace"],
    candidate: {
      formatVersion: 2,
      id: "cand-1",
      experimentId: "exp-1",
      variantId: "default",
      sourceProjectId: "p1",
      baseSnapshotId: "snap-1",
      baseSnapshotHash: "hash-base",
      dependencyHead: {} as ClosedLoopResult["candidate"]["dependencyHead"],
      targetDocument: {
        documentId: "doc-1",
        baseRevision: 1,
        baseContentHash: "hash-base-doc",
      },
      workflowInput: {
        conversationThreadId: "thread-1",
        conversationThreadHash: "thread-hash",
        creativeBriefId: "brief-1",
        creativeBriefHash: "brief-hash",
      },
      manuscript: {
        title: "第一章 草稿",
        summary: "第一章摘要",
        plainText: "章节正文…",
        contentHtml: "<p>章节正文…</p>",
        wordCount: 4,
        contentHash: "hash-manuscript",
      },
      acceptedFacts: [],
      iteratedSkills: [],
      iteratedBindings: [],
      qualityEvidence: {
        weightedScore: 4.2,
        avgScore: 4.0,
        blockerCount: 0,
        majorCount: 1,
        warningCount: 2,
        issueCount: 3,
        dimensionScores: { plot: 4.5, prose: 3.8 },
        topIssues: [],
      },
      provenance: {
        model: "test-model",
        promptFingerprint: "fp-prompt",
        configFingerprint: "fp-config",
        codeRevision: "ui-closed-loop-v1",
        workflowArtifactIds: [],
        experimentStartedAt: 1000,
        exportedAt: 2000,
      },
    },
    check: {
      status: "ready",
      issues: [],
      recomputedDependencyHead: {} as ClosedLoopResult["check"]["recomputedDependencyHead"],
      baselineMatches: true,
      deterministicBlockers: [],
    },
    receipt: undefined,
    canonicalHashBefore: "hash-before",
    canonicalHashAfter: "hash-before",
    workflowRunId: "run-1",
    baseSnapshot: {} as ClosedLoopResult["baseSnapshot"],
    ...overrides,
  };
}

function makeHookReturn(overrides?: Partial<UseClosedLoopResult>): UseClosedLoopResult {
  return {
    run: vi.fn(),
    promote: vi.fn(),
    busy: false,
    error: undefined,
    result: undefined,
    reset: vi.fn(),
    ...overrides,
  };
}

function WithTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

function renderPanel(props: {
  conversationThread?: NovelConversationThread;
  creativeBrief?: CreativeBrief;
  hookReturn?: UseClosedLoopResult;
}) {
  useClosedLoopMock.mockReturnValue(props.hookReturn ?? makeHookReturn());
  return renderToStaticMarkup(
    <WithTheme>
      <ClosedLoopPanel
        projectId="p1"
        document={document}
        conversationThread={props.conversationThread}
        creativeBrief={props.creativeBrief}
      />
    </WithTheme>,
  );
}

function renderResultContent(props: {
  busy?: boolean;
  error?: string;
  result?: ClosedLoopResult;
}) {
  return renderToStaticMarkup(
    <WithTheme>
      <ClosedLoopResultContent
        busy={props.busy ?? false}
        error={props.error}
        result={props.result}
      />
    </WithTheme>,
  );
}

// ===== Tests =====

describe("ClosedLoopPanel", () => {
  beforeEach(() => {
    useClosedLoopMock.mockReset();
  });

  describe("button disabled states", () => {
    it("disables both buttons when conversationThread is missing", () => {
      const html = renderPanel({ creativeBrief: confirmedBrief });
      expect(html).toContain("闭环试运行");
      expect(html).toContain("闭环正式晋升");
      expect(html).toContain("disabled=\"\"");
    });

    it("disables both buttons when creativeBrief.status is not confirmed", () => {
      const html = renderPanel({
        conversationThread,
        creativeBrief: draftBrief,
      });
      expect(html).toContain("disabled=\"\"");
    });

    it("只启用试运行，尚无已检查候选时禁用正式晋升", () => {
      const html = renderPanel({
        conversationThread,
        creativeBrief: confirmedBrief,
      });
      expect(html).toContain("闭环试运行");
      expect(html).toContain("闭环正式晋升");
      expect(html).toContain("disabled=\"\"");
    });

    it("存在 ready 的 dry-run 候选时启用正式晋升", () => {
      const html = renderPanel({
        conversationThread,
        creativeBrief: confirmedBrief,
        hookReturn: makeHookReturn({ result: makeClosedLoopResult() }),
      });
      expect(html).not.toContain("disabled=\"\"");
    });

    it("候选不属于当前章节时保持正式晋升禁用", () => {
      const mismatched = makeClosedLoopResult();
      mismatched.candidate.targetDocument.documentId = "doc-other";
      const html = renderPanel({
        conversationThread,
        creativeBrief: confirmedBrief,
        hookReturn: makeHookReturn({ result: mismatched }),
      });
      expect(html).toContain("disabled=\"\"");
    });
  });

  describe("busy state", () => {
    it("renders busy hint when hook reports busy=true", () => {
      const html = renderPanel({
        conversationThread,
        creativeBrief: confirmedBrief,
        hookReturn: makeHookReturn({ busy: true }),
      });
      expect(html).toContain("执行中");
      expect(html).toContain("可能需要数分钟");
    });

    it("renders loading state inside result content when busy=true and no result/error", () => {
      const html = renderResultContent({ busy: true });
      expect(html).toContain("正在执行闭环评估");
    });
  });

  describe("error state", () => {
    it("renders error alert when error is set", () => {
      const html = renderResultContent({ error: "thread 不存在于正式库：missing-thread" });
      expect(html).toContain("闭环执行失败");
      expect(html).toContain("thread 不存在于正式库：missing-thread");
    });
  });

  describe("result rendering — dry-run (no receipt)", () => {
    it("renders inspect/candidate/hash sections without receipt", () => {
      const result = makeClosedLoopResult({ receipt: undefined });
      const html = renderResultContent({ result });
      expect(html).toContain("执行概览");
      expect(html).toContain("检查结果");
      expect(html).toContain("候选包");
      expect(html).toContain("实验 ID");
      expect(html).toContain("exp-1");
      expect(html).toContain("ready");
      expect(html).toContain("基线一致");
      expect(html).toContain("第一章 草稿");
      expect(html).toContain("本次为 dry-run");
      expect(html).toContain("未变化");
    });
  });

  describe("result rendering — promoted (with receipt)", () => {
    it("renders receipt section with promoted status + hash delta", () => {
      const result = makeClosedLoopResult({
        receipt: {
          candidateId: "cand-1",
          operationId: "promote:cand-1",
          status: "promoted",
          promotedAt: 3000,
          createdRevisionId: "rev-new",
          createdFactAssertionIds: ["fa-1", "fa-2"],
          createdMemoryIds: [],
          createdOperationIds: ["op-1"],
        },
        canonicalHashAfter: "hash-after",
      });
      const html = renderResultContent({ result });
      expect(html).toContain("promoted");
      expect(html).toContain("rev-new");
      expect(html).toContain("新事实");
      expect(html).toContain("2 项");
      expect(html).toContain("已前进");
      expect(html).toContain("hash-after");
      expect(html).toContain("正式库已前进");
    });
  });

  describe("result rendering — rejected receipt", () => {
    it("renders receipt error when inspect failed and promote was rejected", () => {
      const result = makeClosedLoopResult({
        check: {
          ...makeClosedLoopResult().check,
          status: "stale-baseline",
          baselineMatches: false,
          issues: ["target document moved"],
        },
        receipt: {
          candidateId: "cand-1",
          operationId: "promote:cand-1",
          status: "rejected",
          promotedAt: 3000,
          createdFactAssertionIds: [],
          createdMemoryIds: [],
          createdOperationIds: [],
          error: "inspect.status=stale-baseline：target document moved",
        },
      });
      const html = renderResultContent({ result });
      expect(html).toContain("stale-baseline");
      expect(html).toContain("基线漂移");
      expect(html).toContain("rejected");
      expect(html).toContain("晋升被拒绝");
      expect(html).toContain("target document moved");
    });
  });
});
