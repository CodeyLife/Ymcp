import { canonicalSha256 } from "./canonical-json";
import type {
  PromptContextManifest,
  PromptContextSectionReceipt,
  StageContextPriority,
  StageContextRequest,
  StageContextSection,
  StageGoalContract,
  StagePromptPackage,
} from "./protocol";

const PRIORITY_RANK: Record<StageContextPriority, number> = {
  critical: 4,
  required: 3,
  normal: 2,
  soft: 1,
};

export class StageContextBudgetError extends Error {
  constructor(readonly manifest: PromptContextManifest, readonly requiredTokens: number) {
    super(`context-budget-exceeded: 必要上下文需要 ${requiredTokens} tokens，当前输入预算为 ${manifest.maxInputTokens}`);
    this.name = "StageContextBudgetError";
  }
}

export function estimateStageTokens(value: string): number {
  return Math.ceil(value.length / 2);
}

export function createStageGoalContract(input: Omit<StageGoalContract, "id" | "fingerprint" | "createdAt"> & { id?: string; createdAt?: number }): StageGoalContract {
  const createdAt = input.createdAt ?? Date.now();
  const stable = {
    projectId: input.projectId,
    workflowId: input.workflowId,
    stage: input.stage,
    targetArtifactId: input.targetArtifactId,
    authorInstruction: input.authorInstruction?.trim() || undefined,
    reviewIssueFingerprints: [...new Set(input.reviewIssueFingerprints)].sort(),
    acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()).filter(Boolean),
    allowedChangeScope: input.allowedChangeScope,
  };
  const fingerprint = canonicalSha256(stable);
  return { id: input.id ?? `stage-goal:${input.workflowId}:${fingerprint.slice(0, 16)}`, ...stable, fingerprint, createdAt };
}

function normalizeSection(section: StageContextSection): StageContextSection & { fingerprint: string } {
  const text = section.text.trim();
  return {
    ...section,
    text,
    provenanceRefs: [...new Set(section.provenanceRefs)].sort(),
    fingerprint: section.fingerprint ?? canonicalSha256({ text }),
  };
}

function receipt(section: StageContextSection & { fingerprint: string }, status: PromptContextSectionReceipt["status"], reason: PromptContextSectionReceipt["reason"]): PromptContextSectionReceipt {
  return {
    id: section.id,
    kind: section.kind,
    title: section.title,
    priority: section.priority,
    provenanceRefs: section.provenanceRefs,
    sourceArtifactId: section.sourceArtifactId,
    fingerprint: section.fingerprint,
    estimatedTokens: estimateStageTokens(section.text),
    status,
    reason,
  };
}

function renderSection(section: StageContextSection): string {
  return `## ${section.title}\n${section.text}`;
}

export function compileStageContext(request: StageContextRequest, now = Date.now()): StagePromptPackage {
  const systemTokens = estimateStageTokens(request.system ?? "");
  const schemaTokens = request.schema ? estimateStageTokens(JSON.stringify(request.schema)) : 0;
  const usableTokens = Math.max(0, request.maxInputTokens - request.reservedOutputTokens - systemTokens - schemaTokens);
  const normalized = request.sections.map(normalizeSection);
  const receipts: PromptContextSectionReceipt[] = [];
  const candidates: Array<StageContextSection & { fingerprint: string }> = [];
  const contentSeen = new Set<string>();
  const artifactSeen = new Set<string>();

  for (const section of normalized.sort((left, right) => PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority])) {
    if (section.exclusionReason) {
      receipts.push(receipt(section, "excluded", section.exclusionReason));
      continue;
    }
    if (!section.text) {
      receipts.push(receipt(section, "excluded", "empty"));
      continue;
    }
    if (contentSeen.has(section.fingerprint)) {
      receipts.push(receipt(section, "excluded", "duplicate-content"));
      continue;
    }
    if (section.sourceArtifactId && artifactSeen.has(section.sourceArtifactId)) {
      receipts.push(receipt(section, "excluded", "duplicate-source"));
      continue;
    }
    contentSeen.add(section.fingerprint);
    if (section.sourceArtifactId) artifactSeen.add(section.sourceArtifactId);
    candidates.push(section);
  }

  const included: Array<StageContextSection & { fingerprint: string }> = [];
  let spent = 0;
  for (const section of candidates) {
    const tokenCost = estimateStageTokens(renderSection(section));
    const required = section.priority === "critical" || section.priority === "required";
    if (spent + tokenCost <= usableTokens) {
      included.push(section);
      spent += tokenCost;
      receipts.push(receipt(section, "included", required ? "required" : "ranked-fill"));
      continue;
    }
    receipts.push(receipt(section, "excluded", "budget"));
  }

  const instruction = included.map(renderSection).join("\n\n");
  const manifestBase = {
    projectId: request.projectId,
    workflowId: request.workflowId,
    purpose: request.purpose,
    stage: request.stage,
    goalId: request.goal?.id,
    maxInputTokens: request.maxInputTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    estimatedSystemTokens: systemTokens,
    estimatedSchemaTokens: schemaTokens,
    estimatedInputTokens: systemTokens + schemaTokens + estimateStageTokens(instruction),
    sections: receipts,
  };
  const fingerprint = canonicalSha256(manifestBase);
  const manifest: PromptContextManifest = { id: `prompt-context:${request.workflowId}:${fingerprint.slice(0, 16)}`, ...manifestBase, fingerprint, createdAt: now };
  const missingRequired = receipts.filter((item) => item.reason === "budget" && (item.priority === "critical" || item.priority === "required"));
  if (missingRequired.length) {
    const requiredTokens = systemTokens + schemaTokens + candidates
      .filter((item) => item.priority === "critical" || item.priority === "required")
      .reduce((sum, item) => sum + estimateStageTokens(renderSection(item)), 0);
    throw new StageContextBudgetError(manifest, requiredTokens);
  }
  return { system: request.system, instruction, schema: request.schema, goal: request.goal, sections: included, manifest };
}
