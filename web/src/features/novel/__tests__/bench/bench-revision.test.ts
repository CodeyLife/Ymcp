/**
 * Revision 切片测试：复刻 revision-stage.ts 主路径（局部修订模式），
 * 跳过 StageContext 调度，直接调用底层函数 + LLM。
 *
 * 默认 skip，通过 BENCH_STAGE=revision 启用：
 *   BENCH_STAGE=revision npx vitest run --config vitest.bench.config.ts bench-revision.test.ts
 *
 * 前置依赖：foundation.json + ch1-blueprint.json + ch1-draft.json + ch1-quality-report.json
 * 输出：.novel-bench/runs/{ts}-revision/ 目录（output.md / diff.md / rejected-windows.json / prompts/*.md / metrics.json）
 * 预期耗时：3-6 分钟
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
import { countNovelWords } from "../../quality";
import { compileNovelStagePrompt, resolveNovelSkills } from "../../skills";
import { asBlueprint } from "../../workflow-shared";
import { repairDraftStructureOnce } from "../../workflow-stages/draft-structure-repair";
import {
  applyRevisionWindows,
  collectRevisionParagraphs,
  computeTextSimilarity,
  isRevisionRefusal,
  planRevisionWindows,
  REVISION_LOCAL_UNCHANGED_THRESHOLD,
  shouldPromoteWarning,
  splitParagraphs,
  type RevisionWindow,
} from "../../workflow-stages/revision-stage";
import type { QualityIssue } from "../../types";
import {
  loadFixture,
  loadFoundationIntoDb,
  log,
  requireFixture,
  resetDb,
  runBench,
  type FoundationSnapshot,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_STAGE === "revision";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

interface BlueprintFixture {
  contentMarkdown: string;
  structuredData: Record<string, unknown>;
  targetWords: number;
  projectId: string;
  model: string;
  contentProfile: string;
}

interface DraftFixture {
  contentMarkdown: string;
  promptHash: string;
}

interface QualityReportFixture {
  issues: QualityIssue[];
  [key: string]: unknown;
}

// 切片内联一份 isRedundantIssue（源文件中为闭包，不导出）
const redundantRules = new Set(["plot.repeated-progression", "plot.exact-paragraph-return"]);
function isRedundantIssue(item: QualityIssue): boolean {
  if (redundantRules.has(item.rule)) return true;
  const text = `${item.title} ${item.description}`;
  return /重复(推进|事件|收束|补写|展开|段落|信息)|第二个(结尾|结束|开场)|重新开场|重新展开|重新补写/.test(text);
}

describeOrSkip("bench-revision: 切片测试", { timeout: 1_800_000 }, () => {
  it("revises chapter draft based on quality report", async () => {
    await runBench("revision", "revision", async (ctx) => {
      // 1. 加载 fixture + 初始化 DB
      await resetDb();
      const foundation = loadFixture<FoundationSnapshot>("foundation.json");
      await loadFoundationIntoDb(foundation);

      const blueprintFixture = loadFixture<BlueprintFixture>("ch1-blueprint.json");
      requireFixture("ch1-draft.json", "npm run test:bench:draft");
      requireFixture("ch1-quality-report.json", "npm run test:bench:review");
      const draftFixture = loadFixture<DraftFixture>("ch1-draft.json");
      const reportFixture = loadFixture<QualityReportFixture>("ch1-quality-report.json");

      // 2. 解析 skills + blueprint（复刻 revision-stage.ts）
      const skills = await resolveNovelSkills({
        projectId: blueprintFixture.projectId,
        stage: "revision",
        explicitSkillIds: ["embodied-prose", "style-specificity-audit", "imagery-aesthetics"],
      });
      const skillPrompt = compileNovelStagePrompt(skills.skills, "revision");
      const blueprintData = blueprintFixture.structuredData ? asBlueprint(blueprintFixture.structuredData) : undefined;

      // 3. 准备修订输入（复刻 revision-stage.ts）
      const originalParagraphs = splitParagraphs(draftFixture.contentMarkdown);
      const revisableIssues = reportFixture.issues.map((item) =>
        shouldPromoteWarning(item) ? { ...item, severity: "major" as const } : item,
      );
      const redundantIssues = revisableIssues.filter(isRedundantIssue);
      const remainingIssues = revisableIssues.filter((item) => !isRedundantIssue(item));
      const paragraphsToDelete = new Set<number>();
      for (const issue of redundantIssues) {
        const targets = collectRevisionParagraphs(issue, originalParagraphs);
        for (const index of targets) paragraphsToDelete.add(index);
      }

      // 4. planRevisionWindows + 局部修订（复刻 revision-stage.ts 的窗口循环）
      const blockerAndMajor = remainingIssues
        .filter((i) => i.severity === "blocker" || i.severity === "major")
        .slice(0, 12);
      const { windows, unlocated } = planRevisionWindows(blockerAndMajor, originalParagraphs, paragraphsToDelete);

      const mustHappenBlock = blueprintData?.mustHappen?.length
        ? `\n\n## 本章已批准的兑现项（硬约束，不可省略）\n${blueprintData.mustHappen.map((i) => `- ${i}`).join("\n")}\n修订后正文必须保留这些兑现项，但不得由此扩写或提前完成未列入此处的后续大纲节点。`
        : "";
      const forbiddenBlock = blueprintData?.forbidden?.length
        ? `\n\n## 禁止事项（硬约束，不可触犯）\n${blueprintData.forbidden.map((i) => `- ${i}`).join("\n")}`
        : "";

      const issueListFor = (issues: QualityIssue[]) => issues.map((item, index) => {
        const excerptInfo = item.excerpt ? `（原文："${item.excerpt.slice(0, 60)}${item.excerpt.length > 60 ? "..." : ""}"）` : "";
        const ranges = item.revisionRanges?.length
          ? `（段落 ${item.revisionRanges.map((r) => `${r.start}-${r.end}`).join(", ")}）`
          : (typeof item.paragraph === "number" ? `（段落 ${item.paragraph}）` : "");
        const rewriteBlock = item.rewriteExample
          ? `\n  【改写示例——必须参考】\n  ${item.rewriteExample.split("\n").map((l) => `  ${l}`).join("\n")}`
          : `\n  【无改写示例——你必须根据建议自行改写，不得保留原文】`;
        return `${index + 1}. [${item.severity}] ${item.title}${excerptInfo}${ranges}\n  问题：${item.description}\n  修订指令：${item.suggestion}${rewriteBlock}`;
      }).join("\n\n");

      const replacements: Array<RevisionWindow & { replacement: string[] }> = [];
      const promptHashes: string[] = [];
      const rejectedWindows: Array<{ window: RevisionWindow; reason: string }> = [];

      for (const window of windows) {
        const source = originalParagraphs.slice(window.start, window.end + 1).join("\n\n");
        const before = window.start > 0 ? originalParagraphs[window.start - 1] : "（无）";
        const after = window.end + 1 < originalParagraphs.length ? originalParagraphs[window.end + 1] : "（无）";
        const sourceWords = countNovelWords(source);

        const prompt = `只修订原章第 ${window.start + 1}-${window.end + 1} 段。相邻段落仅供衔接，不得重写；输出必须且只能是替换目标段落的连续正文。${mustHappenBlock}${forbiddenBlock}

## 必须处理的问题
${issueListFor(window.issues)}

## 上一段（只读）
${before}

## 待替换段落
${source}

## 下一段（只读）
${after}
`;

        ctx.writeOutput(`prompts/window-${window.start + 1}-${window.end + 1}.md`, prompt);

        let generated;
        try {
          generated = await streamNovelModel({
            model: blueprintFixture.model,
            temperature: 0.25,
            role: "revision-editor",
            skillPrompt,
            timeoutMs: 90_000,
            maxTokens: Math.min(4096, Math.max(1024, Math.ceil(sourceWords * 3))),
            prompt,
          });
        } catch (error) {
          rejectedWindows.push({ window, reason: `LLM 调用失败：${(error as Error).message}` });
          continue;
        }
        promptHashes.push(generated.promptHash);

        // 保真校验（复刻 revision-stage.ts）
        const replacementParagraphs = splitParagraphs(generated.content);
        if (isRevisionRefusal(generated.content)) {
          rejectedWindows.push({ window, reason: "LLM 拒绝提交修订稿" });
          continue;
        }
        if (replacementParagraphs.length === 0) {
          rejectedWindows.push({ window, reason: "修订输出为空" });
          continue;
        }
        const replacementText = replacementParagraphs.join("\n\n");
        const similarity = computeTextSimilarity(source, replacementText);
        if (similarity >= REVISION_LOCAL_UNCHANGED_THRESHOLD) {
          rejectedWindows.push({ window, reason: `修订与原文实质相同 (similarity=${similarity.toFixed(3)})` });
          continue;
        }
        const replacementWords = countNovelWords(replacementText);
        if (replacementWords < Math.max(50, sourceWords * 0.3)) {
          rejectedWindows.push({ window, reason: `修订过短 (${replacementWords} 字 < ${Math.max(50, sourceWords * 0.3)})` });
          continue;
        }
        if (replacementWords > sourceWords * 3 && replacementWords > 1500) {
          rejectedWindows.push({ window, reason: `修订过长 (${replacementWords} 字 > ${sourceWords * 3})` });
          continue;
        }

        replacements.push({ ...window, replacement: replacementParagraphs });
      }

      // 5. applyRevisionWindows + repairDraftStructureOnce（复刻 revision-stage.ts）
      const revisedText = applyRevisionWindows(originalParagraphs, replacements, paragraphsToDelete).join("\n\n");
      const repaired = await repairDraftStructureOnce({
        content: revisedText,
        model: blueprintFixture.model,
        skillPrompt,
      });

      // 6. 输出
      ctx.writeOutput("output.md", repaired.content);
      ctx.writeOutput("diff.md", `# 修订前\n\n${draftFixture.contentMarkdown}\n\n---\n\n# 修订后\n\n${repaired.content}`);
      ctx.writeOutput("rejected-windows.json", rejectedWindows);
      ctx.setMetrics({
        wordCount: countNovelWords(repaired.content),
        revisionWordCount: countNovelWords(repaired.content),
        originalWordCount: countNovelWords(draftFixture.contentMarkdown),
        windowCount: windows.length,
        acceptedWindowCount: replacements.length,
        rejectedWindowCount: rejectedWindows.length,
        unlocatedCount: unlocated.length,
        paragraphsDeleted: paragraphsToDelete.size,
        issueInputCount: reportFixture.issues.length,
        promotedWarningCount: reportFixture.issues.filter((i) => i.severity === "warning" && shouldPromoteWarning(i)).length,
        redundantIssueCount: redundantIssues.length,
        blockerMajorCount: blockerAndMajor.length,
        promptHash: promptHashes[0] ?? null,
      });
      ctx.setMeta({
        model: blueprintFixture.model,
        contentProfile: blueprintFixture.contentProfile,
        skillIds: skills.skills.map((s) => s.skillId),
      });

      log("revision", `windows=${windows.length} accepted=${replacements.length} rejected=${rejectedWindows.length} unlocated=${unlocated.length}`);

      expect(repaired.content.length).toBeGreaterThan(0);
    });
  });
});
