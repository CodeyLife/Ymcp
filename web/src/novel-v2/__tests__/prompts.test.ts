import { describe, expect, it } from "vitest";
import { buildChapterDraftPrompt, buildChapterDraftPromptPackage, dedupeDraftMemory } from "../prompts/chapter-draft";
import { buildChapterReflectionPrompt } from "../prompts/chapter-reflection";
import { buildChapterReviewPrompt, buildChapterReviewPromptPackage, getReviewFocus, groundReviewForText, groundReviewerIssues, toReview, type ReviewerRole } from "../prompts/chapter-review";
import { REVIEW_DIMENSIONS, reviewerSchemaForDimensions, type ReviewerOutput } from "../prompts/schemas";
import type { Artifact, ExecutionBlueprint, MemoryBundle, NovelIntent } from "../protocol";

const artifact: Artifact = { id: "artifact-1", projectId: "p1", taskId: "task-1", attemptId: "attempt-1", kind: "draft", contentHash: "hash", objectKey: "obj", baseRevision: 7, createdAt: 1717000000000, fingerprint: "fp-1" };

function makeIntent(overrides: Partial<NovelIntent> = {}): NovelIntent {
  return {
    id: "intent-1",
    projectId: "p1",
    source: "web",
    objective: "续写第 12 章，让主角首次进入旧铁铺",
    target: { kind: "chapter", id: "doc-12", order: 12 },
    requestedStage: "drafting",
    constraints: ["必须：在场景中呈现旧铁铺招牌", "禁止：揭示师父真实身份"],
    createdAt: 1717000000000,
    idempotencyKey: "k1",
    ...overrides,
  };
}

function makeBlueprint(overrides: Partial<ExecutionBlueprint> = {}): ExecutionBlueprint {
  return {
    id: "blueprint-1",
    projectId: "p1",
    intentId: "intent-1",
    preflightId: "preflight-1",
    memoryBundleId: "memory-1",
    skillBundleId: "skill-1",
    contextManifestId: "context-1",
    baseRevision: 7,
    tasks: [
      { id: "task-draft", kind: "draft", role: "推进主角进入旧铁铺", dependsOn: [], readSet: [], writeSet: [], queue: "writer", independentReviewRequired: false },
      { id: "task-revise", kind: "revise", role: "强化环境意象", dependsOn: ["task-draft"], readSet: [], writeSet: [], queue: "writer", independentReviewRequired: false },
    ],
    commitPolicy: "dual-gate",
    budget: { maxInputTokens: 8000, maxOutputTokens: 12000 },
    fingerprint: "bp-fp",
    createdAt: 1717000000000,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryBundle> = {}): MemoryBundle {
  return {
    id: "memory-1",
    projectId: "p1",
    preflightId: "preflight-1",
    claims: [],
    conflicts: [],
    missingFacets: [],
    tokenBudget: 8000,
    sourceRevisionIds: [],
    fingerprint: "mem-fp",
    createdAt: 1717000000000,
    ...overrides,
  };
}

function makeSkills(overrides: Partial<import("../protocol").SkillBundle> = {}): import("../protocol").SkillBundle {
  return {
    id: "skill-1",
    projectId: "p1",
    preflightId: "preflight-1",
    skills: [],
    conflicts: [],
    missingCapabilities: [],
    fingerprint: "s-fp",
    createdAt: 1,
    ...overrides,
  };
}

describe("prompts buildChapterDraftPrompt", () => {
  const foundationArtifact = (taskKey: string, structuredData: Record<string, unknown>): Artifact => ({
    id: `foundation-${taskKey}`,
    projectId: "p1",
    taskId: `task-${taskKey}`,
    attemptId: `attempt-${taskKey}`,
    kind: "foundation",
    contentHash: `hash-${taskKey}`,
    objectKey: `obj-${taskKey}`,
    baseRevision: 0,
    createdAt: 1717000000000,
    fingerprint: `fp-${taskKey}`,
    structuredData: { taskKey, title: taskKey, summary: `${taskKey} summary`, ...structuredData },
  });

  it("consumes only the current stage section from a cross-stage skill bundle", () => {
    const skills = makeSkills({
      skills: [{
        skillId: "review-only",
        version: "1",
        capabilities: ["review"],
        applicableTasks: ["drafting"],
        requiredMemoryKinds: [],
        qualityGates: [],
        promptSections: { review: "审校时检查场景因果是否成立" },
      }],
    });

    const draftPrompt = buildChapterDraftPrompt({ intent: makeIntent(), blueprint: makeBlueprint(), memory: makeMemory(), skills });

    expect(draftPrompt).not.toContain("审校时检查场景因果是否成立");
    expect(getReviewFocus("plot-reviewer", skills)).toContain("审校时检查场景因果是否成立");
  });

  it("keeps chapter-relevant foundations (characters/worldview/architecture/plot-design) and excludes chapter-plan from the draft package", () => {
    const packageResult = buildChapterDraftPromptPackage({
      workflowId: "wf-long-range",
      system: "writer",
      intent: makeIntent(),
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory(),
      skills: makeSkills(),
      foundationArtifacts: [
        foundationArtifact("characters", { characters: [{ id: "hero", name: "主角", role: "protagonist", motivation: "查明旧案" }] }),
        foundationArtifact("plot-design", { plotStrategy: { narrativePromises: ["真相与选择互相牵动"], nonNegotiables: ["不得覆盖已定稿事实"] } }),
        foundationArtifact("chapter-plan", { chapters: [{ index: 1, title: "旧版开局", summary: "旧版章节表不应进入正文上下文" }] }),
      ],
    });
    const sections = packageResult.manifest.sections;
    expect(sections.find((section) => section.id === "foundation:foundation-characters")?.priority).toBe("required");
    expect(sections.some((section) => section.id === "foundation:foundation-plot-design")).toBe(true);
    expect(sections.some((section) => section.id === "foundation:foundation-chapter-plan")).toBe(false);
    expect(packageResult.instruction).not.toContain("旧版开局");
    expect(packageResult.instruction).toContain("真相与选择互相牵动");
    expect(packageResult.sections.find((section) => section.id === "foundation:foundation-characters")?.text).toContain("查明旧案");
  });

  it("includes hard constraints, blueprint, context and intent sections", () => {
    const prompt = buildChapterDraftPrompt({
      intent: makeIntent(),
      blueprint: makeBlueprint(),
      memory: makeMemory(),
      skills: makeSkills(),
    });
    expect(prompt).toContain("只输出一份连续章节正文");
    expect(prompt).toContain("## 工作流执行编排（不是内容蓝图）");
    expect(prompt).toContain("## 冻结上下文");
    expect(prompt).toContain("## 本章意图");
    expect(prompt).toContain("职业或专业背景是观察、判断与取舍的来源");
    expect(prompt).toContain("外部压力也必须有自己的可观察行动逻辑");
    expect(prompt).toContain("narrativeScale");
    expect(prompt).toContain("沿着 developmentAxes");
    expect(prompt).toContain("不是字数下限");
    expect(prompt).toContain("续写第 12 章");
    expect(prompt).toContain("在场景中呈现旧铁铺招牌");
    expect(prompt).toContain("揭示师父真实身份");
  });

  it("freezes prior chapter rhythm for drafting without turning issue words into quotas", () => {
    const packageResult = buildChapterDraftPromptPackage({
      workflowId: "wf-rhythm",
      system: "writer",
      intent: makeIntent(),
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory({ narrativeRhythm: { arcId: "arc-1", fingerprint: "rhythm-fp", chapters: [{ documentId: "doc-11", narrativeOrder: 11, title: "余波", summary: "两人清理现场但没有谈论争执", keyEvents: ["归还钥匙"], emotionalArc: "紧绷转为克制", narrativeFunction: "aftermath", thematicMode: "absent", themeCarrier: "none", issueFamilies: ["subtext:author-summary"] }] } }),
      skills: makeSkills(),
    });
    const rhythm = packageResult.sections.find((section) => section.id === "narrative-rhythm");
    expect(rhythm?.priority).toBe("required");
    expect(rhythm?.text).toContain("[aftermath/absent/none]");
    expect(rhythm?.text).toContain("归还钥匙");
  });

  it("deduplicates direct planning and episodic chapter history while preserving atomic facts", () => {
    const episodic = { id: "pinned:chapter-11", projectId: "p1", kind: "episodic" as const, title: "第11章定稿记忆", content: "重复的章节摘要", subjectRefs: [], knowledgeScope: "author" as const, authority: "derived" as const, confidence: 1, sourceRevisionIds: ["rev-11"], contentHash: "episodic", supersedes: [], score: 1, matchedFacet: "chapter-memory", reason: "pinned" };
    const fact = { ...episodic, id: "fact:key", kind: "canonical" as const, title: "钥匙归属", content: "钥匙仍由甲保管", contentHash: "fact", matchedFacet: "fact" };
    const planningClaim = { ...episodic, id: "planning-context:fp", kind: "working" as const, title: "重复规划", contentHash: "planning" };
    const foundationClaim = { ...episodic, id: "foundation:macro", kind: "hierarchical" as const, title: "全局主题定位", contentHash: "foundation", sourceRevisionIds: [] };
    const memory = makeMemory({
      claims: [episodic, fact, planningClaim, foundationClaim],
      narrativeRhythm: { arcId: "arc-1", fingerprint: "rhythm-fp", chapters: [{ documentId: "doc-11", revisionId: "rev-11", narrativeOrder: 11, title: "前章", summary: "重复的章节摘要", keyEvents: [], issueFamilies: [] }] },
    });

    const projected = dedupeDraftMemory({ intent: makeIntent(), blueprint: makeBlueprint(), memory, skills: makeSkills(), planningContext: {} as never });
    expect(projected.claims.map((claim) => claim.id)).toEqual(["fact:key"]);
  });

  it("extracts mustHappen/forbidden from intent.constraints via Chinese prefixes", () => {
    const prompt = buildChapterDraftPrompt({
      intent: makeIntent({ constraints: ["必须：先呈现 A", "应当：再铺垫 B", "禁止：暴露 C", "不得：使用 D"] }),
      blueprint: makeBlueprint(),
      memory: makeMemory(),
      skills: makeSkills(),
    });
    expect(prompt).toContain("先呈现 A");
    expect(prompt).toContain("再铺垫 B");
    expect(prompt).toContain("暴露 C");
    expect(prompt).toContain("使用 D");
  });

  it("falls back to empty-list placeholders when constraints are absent", () => {
    const prompt = buildChapterDraftPrompt({
      intent: makeIntent({ constraints: undefined }),
      blueprint: makeBlueprint(),
      memory: makeMemory(),
      skills: makeSkills(),
    });
    expect(prompt).toContain("无额外硬性节拍");
    expect(prompt).toContain("无额外禁止事项");
  });

  it("renders memory claims ordered by authority (approved > author > derived > candidate)", () => {
    const prompt = buildChapterDraftPrompt({
      intent: makeIntent(),
      blueprint: makeBlueprint(),
      memory: makeMemory({
        claims: [
          { id: "c1", projectId: "p1", kind: "canonical", title: "候选", content: "候选内容", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "candidate", confidence: 0.9, sourceRevisionIds: [], contentHash: "h1", supersedes: [], score: 0.9, matchedFacet: "fact", reason: "x" },
          { id: "c2", projectId: "p1", kind: "canonical", title: "核准", content: "核准内容", subjectRefs: ["hero"], narrativeRange: { start: 4 }, knowledgeScope: "author", authority: "approved", confidence: 0.7, sourceRevisionIds: [], contentHash: "h2", supersedes: [], score: 0.5, matchedFacet: "entity", reason: "x" },
        ],
      }),
      skills: makeSkills(),
    });
    const approvedIndex = prompt.indexOf("[approved/canonical]");
    const candidateIndex = prompt.indexOf("[candidate/canonical]");
    expect(approvedIndex).toBeGreaterThan(-1);
    expect(candidateIndex).toBeGreaterThan(-1);
    expect(approvedIndex).toBeLessThan(candidateIndex);
  });

  it("renders active skills with quality gates", () => {
    const prompt = buildChapterDraftPrompt({
      intent: makeIntent(),
      blueprint: makeBlueprint(),
      memory: makeMemory(),
      skills: makeSkills({
        skills: [
          { skillId: "longform-continuity", version: "1.0.0", qualityGates: ["continuity"], promptSections: { drafting: "保持长篇连续性。" } },
        ],
      }),
    });
    expect(prompt).toContain("longform-continuity@1.0.0");
    expect(prompt).toContain("gates=continuity");
  });

  it("compiles draft sources into independently budgeted manifest sections", () => {
    const packageResult = buildChapterDraftPromptPackage({
      workflowId: "wf-draft",
      system: "writer",
      intent: makeIntent(),
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory({ claims: [{ id: "claim-1", projectId: "p1", kind: "canonical", title: "钥匙", content: "主角持有旧钥匙", subjectRefs: ["hero"], knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: [], contentHash: "claim-hash", supersedes: [], score: 1, matchedFacet: "fact", reason: "test" }] }),
      skills: makeSkills({ skills: [{ skillId: "dialogue", version: "1.0.0", qualityGates: ["dialogue"], promptSections: { drafting: "对白以行动和停顿承载潜台词。" } }] }),
    });
    expect(packageResult.manifest.sections.map((section) => section.id)).toEqual(expect.arrayContaining(["draft-instruction", "execution-blueprint", "memory:claim-1", "skill:dialogue"]));
    expect(packageResult.instruction.match(/对白以行动和停顿承载潜台词。/g)).toHaveLength(1);
  });

  it("treats replacement outcomes as critical execution boundaries", () => {
    const packageResult = buildChapterDraftPromptPackage({
      workflowId: "wf-replacement-draft",
      system: "writer",
      intent: makeIntent(),
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory({ claims: [{ id: "replacement-1", projectId: "p1", kind: "episodic", title: "既有章节终态", content: "保留会面发生与章末获得钥匙，不复述旧对白。", subjectRefs: ["hero"], knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["revision-7"], contentHash: "replacement-hash", supersedes: [], score: 1, matchedFacet: "chapter-memory", reason: "replacement-boundary" }] }),
      skills: makeSkills(),
    });

    const boundary = packageResult.manifest.sections.find((section) => section.id === "memory:replacement-1");
    expect(boundary?.title).toBe("替换式生成硬边界（必须保留事件结果，不得复述旧表达）");
    expect(boundary?.priority).toBe("critical");
  });

  it("projects character knowledge as an epistemic boundary instead of reusable prose", () => {
    const packageResult = buildChapterDraftPromptPackage({
      workflowId: "wf-knowledge-boundary",
      system: "writer",
      intent: makeIntent(),
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory({ claims: [{ id: "knowledge-1", projectId: "p1", kind: "episodic", title: "旧标题含作者式解释", content: "主角 在第11章得知：来客声称旧钥匙能打开北门\n证据：来客把钥匙拍在桌上，说这就是北门钥匙。", subjectRefs: ["hero"], knowledgeScope: { characterId: "hero" }, authority: "derived", confidence: 0.85, sourceRevisionIds: ["revision-11"], contentHash: "knowledge-hash", supersedes: [], score: 1, matchedFacet: "entity", reason: "test" }] }),
      skills: makeSkills(),
    });

    const knowledge = packageResult.manifest.sections.find((section) => section.id === "memory:knowledge-1");
    expect(knowledge?.title).toContain("角色知识边界：hero");
    expect(packageResult.instruction).toContain("可知命题：来客声称旧钥匙能打开北门");
    expect(packageResult.instruction).toContain("不得照搬为对白、叙述、主题结论或客观世界规则");
    expect(packageResult.instruction).not.toContain("来客把钥匙拍在桌上");
    expect(knowledge?.title).not.toContain("旧标题含作者式解释");
  });
});

describe("prompts buildChapterReviewPrompt", () => {
  const roles: ReviewerRole[] = ["style-reviewer", "character-reviewer", "continuity-reviewer", "plot-reviewer", "reader-reviewer"];

  it("renders numbered draft, blueprint summary and reviewer context for each role", () => {
    for (const role of roles) {
      const prompt = buildChapterReviewPrompt({
        role,
        artifact,
        text: "第一段。\n\n第二段。",
        blueprint: makeBlueprint(),
        memory: makeMemory(),
      });
      expect(prompt).toContain("独立审校下面正文");
      expect(prompt).toContain("### 段落 1");
      expect(prompt).toContain("### 段落 2");
      expect(prompt).toContain("Blueprint ID: blueprint-1");
      expect(prompt).toContain(`artifactId: ${artifact.id}`);
    }
  });

  it("uses role-specific focus text for each reviewer", () => {
    // P1-2: 职责定义移到 system prompt（通过 getReviewFocus），user prompt 只保留维度边界。
    // 测试验证 getReviewFocus 返回值包含职责文案，且 user prompt 不再重复职责定义。
    const styleFocus = getReviewFocus("style-reviewer");
    expect(styleFocus).toContain("解释性心理总结");
    expect(styleFocus).toContain("不得以关键词出现次数判断");
    expect(styleFocus).toContain("foreground");
    const stylePrompt = buildChapterReviewPrompt({ role: "style-reviewer", artifact, text: "x", blueprint: makeBlueprint(), memory: makeMemory() });
    expect(stylePrompt).toContain("sceneEmbodiment、specificity、humor"); // 维度边界仍在 user prompt

    const continuityFocus = getReviewFocus("continuity-reviewer");
    expect(continuityFocus).toContain("POV 越界");

    const plotFocus = getReviewFocus("plot-reviewer");
    expect(plotFocus).toContain("chapter.incomplete-blueprint");
    expect(plotFocus).toContain("必须逐项核对候选是否保留事件身份、章末状态与未解线索");
    expect(getReviewFocus("reader-reviewer")).toContain("节奏不是快慢分数");
  });

  it("renders reviewer context with authority/kind/subject/title", () => {
    const prompt = buildChapterReviewPrompt({
      role: "character-reviewer",
      artifact,
      text: "x",
      blueprint: makeBlueprint(),
      memory: makeMemory({
        claims: [
          { id: "c1", projectId: "p1", kind: "canonical", title: "事实一", content: "内容一", subjectRefs: ["hero"], narrativeRange: { start: 1 }, knowledgeScope: "author", authority: "approved", confidence: 0.9, sourceRevisionIds: [], contentHash: "h1", supersedes: [], score: 0.9, matchedFacet: "fact", reason: "x" },
        ],
      }),
    });
    expect(prompt).toContain("[approved/canonical]");
    expect(prompt).toContain("hero");
    expect(prompt).toContain("事实一");
  });

  it("injects dynamic reviewer skills only once in the compiled package", () => {
    const packageResult = buildChapterReviewPromptPackage({
      workflowId: "wf-review",
      system: "reader reviewer",
      role: "reader-reviewer",
      artifact,
      text: "第一段。",
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory(),
      skills: makeSkills({ skills: [{ skillId: "reader-specific", version: "1.0.0", qualityGates: [], promptSections: { review: "唯一审校规则：关注隐含冲突。" } }] }),
      payoffStats: { recentChapters: [], consecutiveNoPayoff: 2, totalPayoffs: 0, byType: {} },
    });
    expect(packageResult.instruction.match(/唯一审校规则：关注隐含冲突。/g)).toHaveLength(1);
    expect(packageResult.manifest.sections.filter((section) => section.id === "payoff-stats")).toHaveLength(1);
  });

  it("makes replacement outcomes required for plot review", () => {
    const packageResult = buildChapterReviewPromptPackage({
      workflowId: "wf-replacement-review",
      system: "plot reviewer",
      role: "plot-reviewer",
      artifact,
      text: "主角完成会面，却空手离开。",
      blueprint: makeBlueprint({ budget: { maxInputTokens: 20_000, maxOutputTokens: 4_000 } }),
      memory: makeMemory({ claims: [{ id: "replacement-1", projectId: "p1", kind: "episodic", title: "既有章节终态", content: "保留会面发生与章末获得钥匙，不复述旧对白。", subjectRefs: ["hero"], knowledgeScope: "author", authority: "approved", confidence: 1, sourceRevisionIds: ["revision-7"], contentHash: "replacement-hash", supersedes: [], score: 1, matchedFacet: "chapter-memory", reason: "replacement-boundary" }] }),
      skills: makeSkills(),
    });

    const boundary = packageResult.manifest.sections.find((section) => section.id === "memory:replacement-1");
    expect(boundary?.title).toBe("替换式生成验收边界");
    expect(boundary?.priority).toBe("required");
  });

  it("states that word count is not an audit target", () => {
    const prompt = buildChapterReviewPrompt({
      role: "reader-reviewer",
      artifact,
      text: "短章也可以完整完成一次余波。",
      blueprint: makeBlueprint(),
      memory: makeMemory(),
    });

    expect(prompt).toContain("字数、字符数、段落数量或是否达到某个目标篇幅，不是审校目标");
    expect(prompt).toContain("不能单独触发降分");
    expect(prompt).toContain("必须把问题改写为具体机制");
    expect(prompt).toContain("chapter.premature-closure");
    expect(prompt).toContain("developmentAxes 是否在正文中被实际经历");
  });
});

describe("prompts buildChapterReflectionPrompt", () => {
  it("does not let word count become a reflection target", () => {
    const prompt = buildChapterReflectionPrompt({
      artifact,
      text: "第一段。\n\n第二段。",
      blueprint: makeBlueprint(),
      memory: makeMemory(),
    });

    expect(prompt).toContain("字数、字符数、段落数量或是否达到某个目标篇幅，不是反思/审校目标");
    expect(prompt).toContain("不能单独触发 blocker、major 或 warning");
    expect(prompt).toContain("找不到机制证据时不得输出 issue");
  });
});

describe("prompts toReview projection", () => {
  function makeReviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
    return {
      verdict: "revise",
      scores: { plot: 4, characterVoice: 3, sceneEmbodiment: 3, dialogue: 4, specificity: 3, hookPayoff: 4, continuity: 5, readerRetention: 4, worldbuilding: 4, ensemble: 3, romance: 4, humor: 3, subtext: 4, narrativePacing: 4 },
      issues: [
        {
          dimension: "characterVoice",
          severity: "major",
          title: "对白声部同质化",
          description: "两个次要角色交换名字后读起来一样。",
          excerpt: "甲说……乙说……",
          paragraph: 3,
          revisionRanges: [{ start: 3, end: 3 }],
          rule: "dialogue.voice-fingerprint",
          suggestion: "给乙一个犹豫的停顿。",
          rewriteExample: "【原文】乙说：好的。【改写】乙沉默了片刻，把杯子推远：『再想想。』",
        },
      ],
      ...overrides,
    };
  }

  it("maps all ReviewerOutput fields onto Review with stable identity metadata", () => {
    const review = toReview({ artifact, identity: "independent", role: "character-reviewer", output: makeReviewerOutput() });
    expect(review).toMatchObject({
      projectId: artifact.projectId,
      artifactId: artifact.id,
      reviewerId: "independent-character-reviewer",
      identity: "independent",
      role: "character-reviewer",
      verdict: "revise",
      artifactFingerprint: artifact.fingerprint,
    });
    expect(review.id).toBeTruthy();
    expect(review.createdAt).toBeGreaterThan(0);
    const issue = review.issues[0];
    expect(issue).toMatchObject({
      severity: "major",
      dimension: "characterVoice",
      rule: "dialogue.voice-fingerprint",
      suggestion: "给乙一个犹豫的停顿。",
      rewriteExample: expect.stringContaining("【改写】"),
    });
    // evidence 回退到 description 当 excerpt 缺失
    expect(issue.evidence).toBe("甲说……乙说……");
  });

  it("falls back evidence to description when excerpt is absent", () => {
    const review = toReview({
      artifact,
      identity: "internal",
      role: "plot-reviewer",
      output: makeReviewerOutput({
        issues: [
          {
            dimension: "plot",
            severity: "blocker",
            title: "未完成节拍",
            description: "最后节拍只写到开头。",
            revisionRanges: [{ start: 8, end: 9 }],
            rule: "chapter.incomplete-blueprint",
            suggestion: "补全落点。",
            rewriteExample: "结构问题，需在第 8 段增加章尾反应。",
          },
        ],
      }),
    });
    expect(review.issues[0].excerpt).toBeUndefined();
    expect(review.issues[0].evidence).toBe("最后节拍只写到开头。");
  });

  it("drops reviewer issues whose quoted evidence is absent from the current candidate text", () => {
    const output = makeReviewerOutput({
      issues: [
        {
          dimension: "specificity",
          severity: "major",
          title: "旧稿术语残留",
          description: "引用了上一版正文的技术词。",
          excerpt: "把身体机能拆解为“呼吸系统”、“运动系统”和“痛觉反馈”三个模块",
          revisionRanges: [{ start: 4, end: 4 }],
          rule: "review.evidence-grounding",
          suggestion: "只处理当前正文真实存在的术语。",
          rewriteExample: "【原文】旧稿术语。【改写】当前正文没有该句，不应报告。",
        },
      ],
    });

    const review = toReview({
      artifact,
      identity: "independent",
      role: "style-reviewer",
      output,
      text: "他把手按在心口，沿着痛楚变弱的一线空隙，极慢地换了一口气。",
    });

    expect(review).toMatchObject({ verdict: "passed", issues: [] });
    expect(review.score).toBeUndefined();
  });

  it("keeps current-text evidence, including multi-fragment excerpts", () => {
    const issues = [
      {
        severity: "major" as const,
        title: "配角动作工具化",
        evidence: "那人用剑尖挑开湿重的芦苇……抬起袖子在脸前用力扇了扇",
      },
      {
        severity: "major" as const,
        title: "旧稿术语残留",
        evidence: "呼吸系统、运动系统和痛觉反馈三个模块",
      },
    ];

    const grounded = groundReviewerIssues(
      issues,
      "那人没有说话，只有急促的鼻息喷涌声。接着是一声钝响，那人用剑尖挑开湿重的芦苇，又抬起袖子在脸前用力扇了扇。",
    );

    expect(grounded.discardedCount).toBe(1);
    expect(grounded.issues.map((issue) => issue.title)).toEqual(["配角动作工具化"]);
  });

  it("re-grounds persisted reviews before reuse against a later candidate", () => {
    const review = toReview({ artifact, identity: "independent", role: "style-reviewer", output: makeReviewerOutput() });
    const grounded = groundReviewForText(review, "旧铁铺的门半开着，门槛上积着雨水。");
    expect(grounded.verdict).toBe("passed");
    expect(grounded.issues).toEqual([]);
  });

  it("preserves all REVIEW_DIMENSIONS in the scores object contract", () => {
    const output = makeReviewerOutput();
    expect(Object.keys(output.scores).sort()).toEqual([...REVIEW_DIMENSIONS].sort());
  });

  it("requires issue excerpts in the structured reviewer schema", () => {
    const issueSchema = ((reviewerSchemaForDimensions(["plot"]) as Record<string, any>).properties.issues.items as Record<string, any>);
    expect(issueSchema.required).toContain("excerpt");
  });
});
