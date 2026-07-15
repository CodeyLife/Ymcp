import { compileNovelContext } from "../context";
import { novelMemoryService } from "../memory-service";
import { resolveNovelSkills } from "../skills";
import { BUILTIN_CHAPTER_WORKFLOW } from "../workflow-shared";
import type { StageContext, StageHandler, StageResult } from "../workflow-stages";

export const contextStageHandler: StageHandler = {
  stage: "context",
  async execute(ctx: StageContext): Promise<StageResult> {
    const { run, document } = ctx;
    const prompt = await ctx.latestArtifact(run.id, ["prompt"]);
    const skills = await resolveNovelSkills({
      projectId: run.projectId,
      stage: "planning",
      explicitSkillIds: BUILTIN_CHAPTER_WORKFLOW.requiredSkillIds,
    });
    if (skills.conflicts.length) {
      throw new Error(`Skill 冲突：${skills.conflicts.map((item) => `${item.skillId} ↔ ${item.conflictsWith}`).join("；")}`);
    }
    const instruction = prompt?.contentMarkdown || "为当前章节执行标准创作工作流";
    const packet = run.conversationThreadId
      ? await novelMemoryService.compileStageContext({ threadId: run.conversationThreadId, stage: "context", role: "architect", instruction, workflowRunId: run.id, skillStage: "planning" })
      : await compileNovelContext({ projectId: run.projectId, task: "chapter-workflow", instruction, targetDocumentId: document.id, stage: "planning", resolvedSkills: skills.skills });
    const nextRun = await ctx.transition(run, "blueprint", "running", { contextPacketId: packet.id });
    return { run: nextRun };
  },
};
