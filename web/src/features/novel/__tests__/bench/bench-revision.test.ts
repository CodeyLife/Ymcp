/**
 * Revision 切片测试：复刻 revision-stage.ts 主路径（局部修订模式），
 * 跳过 StageContext 调度，直接调用底层函数 + LLM。
 *
 * 默认 skip，通过 BENCH_STAGE=revision 启用：
 *   BENCH_STAGE=revision npx vitest run --config vitest.bench.config.ts bench-revision.test.ts
 *
 * 前置依赖：foundation.json + 选定章节的 blueprint/draft/quality-report fixture
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
  saveFixture,
  type FoundationSnapshot,
} from "./bench-helpers";

const SHOULD_RUN = process.env.BENCH_STAGE === "revision";
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;
const BENCH_CHAPTER = process.env.BENCH_CHAPTER === "ch2" ? "ch2" : "ch1";

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

      const blueprintFixture = loadFixture<BlueprintFixture>(`${BENCH_CHAPTER}-blueprint.json`);
      requireFixture(`${BENCH_CHAPTER}-draft.json`, "npm run test:bench:draft");
      requireFixture(`${BENCH_CHAPTER}-quality-report.json`, "npm run test:bench:review");
      const draftFixture = loadFixture<DraftFixture>(`${BENCH_CHAPTER}-draft.json`);
      const reportFixture = loadFixture<QualityReportFixture>(`${BENCH_CHAPTER}-quality-report.json`);

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
        ? `\n\n## 本章已批准的兑现项（整章只读防丢清单）\n${blueprintData.mustHappen.map((i) => `- ${i}`).join("\n")}\n这些条目只用于防止局部修订删除原窗口已经承载的整章内容，不是当前窗口的新增任务。若待替换原文没有承载某条兑现项，修订输出不得新增、概述或提前完成该条目；不得把其它段落或未来事件压缩进当前窗口。`
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

## 局部修订契约
1. 保留目标段落承担的事件、信息、人物声音与视角，只解决列出的问题。
2. 不得新增原文与已批准蓝图中都不存在的物件、行动、关系、线索或事实。
3. 不得把局部问题扩写成新场景，不得复述相邻段落，不得解释修订过程。
4. 边界不复述硬约束：修订输出不得逐句复述"上一段"或"下一段"。若需要衔接，只用必要的动作、时间或场景状态自然承接，不得复制相邻段落的完整句子。

## 修订时声音与视角硬约束（违反即重写）
1. 单 POV 视角：修订不得引入全知判断或替视角人物总结他人心理。他人内在状态只能通过可见动作、神态、对白、呼吸、停顿外化呈现。禁止"他知道X不会无故Y""像是在提醒自己""他心中……"式越界——改写为视角人物可观察的具体动作或记录。判定标准：把描述他人状态的句子改写为"视角人物能看到/听到的具体动作"后若信息丢失，则该句子越界，必须改写。
2. 禁止作者式心理结论句：修订不得新增"她第一次知道/她忽然懂得/这意味着/不是……而是……"式心理总结，也不得新增格言式训诫（如"宫里最不值钱的是时间"）。禁止"若X，日后无人能说清；若Y，又难保有人Z"式二选一心理权衡总结——改写为视角人物当下可观察的动作、物件状态或具体反应（如"指尖停在名册最后一行，停了片刻，才取印按下"）。
3. 对白声线区分：只从冻结上下文中的年龄、职业、关系距离、目标、知识边界和既有表达习惯推导声部，不得套用固定身份模板。修订不得让蓝图未安排开口的角色新增对白，也不得为了制造交锋改变角色立场。
4. 生成时自检：写到对白时立即检查——这句换成另一角色说是否一样？若一样，立即改写使其符合自身声部。写到他人心理时立即改为可观察动作。写到环境意象时检查它是否改变了人物判断或引发新行动——若只承担氛围，删除或改写为可驱动判断的细节。
5. 禁止作者把多个角色、事件或关系压缩成一句全知因果总结。需要表达汇合或影响时，只写视角人物能够观察、回忆或合理推断的具体变化，让读者自行建立联系。
6. 章尾必须服从已批准蓝图。蓝图若明确保留未回答、未决定或未完成的选择，修订不得替人物答应、拒绝或完成选择；只能通过原有行动被打断、可用选项收窄或外部关系继续施压来落实处境变化。不能只停在看景、沉默或泛化情绪，也不得另造新事件强行制造压力。
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
      saveFixture(`${BENCH_CHAPTER}-draft.json`, {
        contentMarkdown: repaired.content,
        promptHash: repaired.promptHash ?? (promptHashes.join("+") || draftFixture.promptHash),
      });
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
