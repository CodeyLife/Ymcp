/**
 * Draft 切片测试：复刻 draft-stage.ts 核心路径，直接调用底层 LLM + prompt 函数。
 *
 * 默认 skip，通过 BENCH_STAGE=draft 启用：
 *   BENCH_STAGE=draft npx vitest run --config vitest.bench.config.ts bench-draft.test.ts
 *
 * 前置依赖：foundation.json + ch1-blueprint.json + ch1-context-packet.json（由 bench-bootstrap 生成）
 * 输出：.novel-bench/runs/{ts}-draft/ 目录（output.md / prompt.md / metrics.json / meta.json）
 * 滚动 fixture：保存 ch1-draft.json 供 review/revision 切片使用
 * 预期耗时：3-5 分钟
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_API_KEY } from "@/config/defaults";

// DEV 代理绕过：让 getEffectiveApiConfig 返回带显式 :443 端口的等价 URL
vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://gpt.eromaa.com:443/v1",
      apiKey: DEFAULT_API_KEY,
      usesDefaultBaseUrl: false,
      hasOwnKey: true,
      modelContextWindow: 0,
    }),
  };
});

import { streamNovelModel } from "../../ai";
import {
  buildChapterDraftPrompt,
  buildDraftSectionContract,
  chapterOutputTokenBudget,
  planDraftSections,
} from "../../prose-prompts";
import { compileNovelStagePrompt, resolveNovelSkills } from "../../skills";
import { asBlueprint } from "../../workflow-shared";
import { countNovelWords, runDeterministicQualityChecks } from "../../quality";
import { repairDraftStructureOnce } from "../../workflow-stages/draft-structure-repair";
import {
  loadFixture,
  loadFoundationIntoDb,
  log,
  resetDb,
  runBench,
  saveFixture,
  type FoundationSnapshot,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_STAGE === "draft";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;
// 支持 BENCH_CHAPTER=ch2 选择不同章节 fixture（多场景验证）
const BENCH_CHAPTER = process.env.BENCH_CHAPTER === "ch2" ? "ch2" : "ch1";

interface BlueprintFixture {
  contentMarkdown: string;
  structuredData: Record<string, unknown>;
  targetWords: number;
  documentTitle: string;
  documentId: string;
  projectId: string;
  povCharacterId?: string;
  model: string;
  temperature: number;
  contentProfile: string;
}

interface ContextFixture {
  formattedContext: string;
  formattedReviewerContext: string;
  rawPacket: unknown;
}

describeOrSkip("bench-draft: 切片测试", { timeout: 1_800_000 }, () => {
  it("generates chapter draft from blueprint fixture", async () => {
    const { result: draft, runId } = await runBench("draft", "draft", async (ctx) => {
      // 1. 加载 fixture + 初始化 DB
      log("draft", "加载 fixture 并初始化 DB");
      await resetDb();
      const foundation = loadFixture<FoundationSnapshot>("foundation.json");
      await loadFoundationIntoDb(foundation);
      const blueprintFixture = loadFixture<BlueprintFixture>(`${BENCH_CHAPTER}-blueprint.json`);
      const contextFixture = loadFixture<ContextFixture>("ch1-context-packet.json");

      // 2. 解析 skills（与 draft-stage.ts 完全一致）
      log("draft", "解析 skills");
      const skills = await resolveNovelSkills({
        projectId: blueprintFixture.projectId,
        stage: "drafting",
        explicitSkillIds: [
          "embodied-prose",
          "serial-rhythm",
          "character-voice-matrix",
          "imagery-aesthetics",
          "prose-discipline",
        ],
      });
      const skillPrompt = compileNovelStagePrompt(skills.skills, "drafting");

      // 3. 构建 blueprintData（与 draft-stage.ts 一致）
      const blueprintData = blueprintFixture.structuredData
        ? asBlueprint(blueprintFixture.structuredData)
        : undefined;
      const forbidden = blueprintData?.forbidden ?? [];
      const mustHappen = blueprintData?.mustHappen ?? [];
      const endingHook = blueprintData?.endingHook;
      const beats = Array.isArray(blueprintFixture.structuredData?.beats)
        ? (blueprintFixture.structuredData.beats as Array<{
            action: string;
            emotion: string;
            outcome: string;
          }>)
        : [];
      const sections = planDraftSections(beats, blueprintFixture.targetWords);
      log("draft", `规划 ${sections.length} 个分段`);

      // 4. 构建完整 prompt（用于输出 prompt.md）
      const fullPrompt = buildChapterDraftPrompt({
        targetWords: blueprintFixture.targetWords,
        blueprintMarkdown: blueprintFixture.contentMarkdown,
        contextMarkdown: contextFixture.formattedContext,
        mustHappen,
        forbidden,
      });
      ctx.writeOutput("prompt.md", fullPrompt);

      // 5. 分段生成（复刻 draft-stage.ts 的 section 循环）
      const sectionContents: string[] = [];
      const promptHashes: string[] = [];
      for (const section of sections) {
        const previousEnding = sectionContents.join("\n\n").slice(-1200);
        const sectionPrompt = `${fullPrompt}\n\n${buildDraftSectionContract(section, previousEnding, endingHook)}`;
        ctx.writeOutput(`prompt-section-${section.index + 1}.md`, sectionPrompt);
        log("draft", `→ 生成第 ${section.index + 1}/${sections.total} 段`);
        const generated = await streamNovelModel({
          model: blueprintFixture.model,
          temperature: blueprintFixture.temperature,
          role: "writer",
          skillPrompt,
          maxTokens: chapterOutputTokenBudget(section.targetWords),
          prompt: sectionPrompt,
        });
        sectionContents.push(generated.content);
        promptHashes.push(generated.promptHash);
      }

      // 6. 结构修复（复刻 draft-stage.ts）
      log("draft", "结构修复");
      const combined = sectionContents.join("\n\n");
      const repaired = await repairDraftStructureOnce({
        content: combined,
        model: blueprintFixture.model,
        skillPrompt,
      });

      // 7. 机械预检（复刻 draft-stage.ts 的 runDeterministicQualityChecks）
      log("draft", "机械预检");
      const preCheck = runDeterministicQualityChecks({
        text: repaired.content,
        blueprint: blueprintData,
      });
      if (preCheck.issues.length > 0) {
        const major = preCheck.issues.filter(
          (i) => i.severity === "major" || i.severity === "blocker",
        );
        const warning = preCheck.issues.filter((i) => i.severity === "warning");
        log(
          "draft",
          `机械预检发现 ${major.length} 个 major+/blocker、${warning.length} 个 warning`,
        );
      }

      // 8. 输出 + 指标
      ctx.writeOutput("output.md", repaired.content);
      ctx.setMetrics({
        wordCount: countNovelWords(repaired.content),
        issueCount: preCheck.issues.length,
        majorCount: preCheck.issues.filter((i) => i.severity === "major").length,
        blockerCount: preCheck.issues.filter((i) => i.severity === "blocker").length,
        warningCount: preCheck.issues.filter((i) => i.severity === "warning").length,
        sectionCount: sections.length,
        paragraphCount: repaired.content.split(/\n\s*\n/).filter((p) => p.trim()).length,
        promptHash: repaired.promptHash ?? promptHashes.join("+"),
      });
      ctx.setMeta({
        model: blueprintFixture.model,
        contentProfile: blueprintFixture.contentProfile,
        targetWords: blueprintFixture.targetWords,
      });

      // 9. 保存滚动 fixture 供 review/revision 切片使用
      saveFixture(`${BENCH_CHAPTER}-draft.json`, {
        contentMarkdown: repaired.content,
        promptHash: repaired.promptHash ?? promptHashes.join("+"),
      });

      return { content: repaired.content, wordCount: countNovelWords(repaired.content) };
    });

    log("draft", `完成：runId=${runId} 字数=${draft.wordCount}`);
    expect(draft.content.length).toBeGreaterThan(1000);
    expect(draft.wordCount).toBeGreaterThan(800);
  });
});
