import { createHash } from "node:crypto";
import type { Artifact, MemoryClaim, MemoryKind } from "./protocol";

const kindByTaskKey: Record<string, MemoryKind> = {
  "project-positioning": "author",
  architecture: "hierarchical",
  characters: "canonical",
  relations: "canonical",
  worldview: "canonical",
  "plot-threads": "hierarchical",
  foreshadowing: "hierarchical",
  timeline: "hierarchical",
  "story-control": "author",
  "plot-design": "hierarchical",
  "chapter-plan": "hierarchical",
};

function compactStructuredData(value: unknown): string {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= 12_000 ? serialized : `${serialized.slice(0, 12_000)}…`;
}

/** Projects an accepted foundation artifact into durable, derived cognition. */
export function foundationArtifactToMemoryClaim(
  artifact: Artifact,
  input: { objective?: string },
): MemoryClaim {
  const data = artifact.structuredData ?? {};
  const taskKey = typeof data.taskKey === "string" ? data.taskKey : "foundation";
  const title = typeof data.title === "string" ? data.title : taskKey;
  const summary = typeof data.summary === "string" ? data.summary : "";
  const content = [
    input.objective ? `项目目标：${input.objective}` : undefined,
    `规划维度：${taskKey}`,
    `规划标题：${title}`,
    summary ? `规划摘要：${summary}` : undefined,
    `结构化决策：${compactStructuredData(data.structuredData ?? data)}`,
  ].filter(Boolean).join("\n");
  const contentHash = createHash("sha256").update(content).digest("hex");

  return {
    id: `foundation:${artifact.id}`,
    projectId: artifact.projectId,
    kind: kindByTaskKey[taskKey] ?? "hierarchical",
    title: `[foundation:${taskKey}] ${title}`,
    content,
    subjectRefs: [`foundation:${taskKey}`, "facet:fact"],
    knowledgeScope: "author",
    authority: "derived",
    confidence: 0.8,
    sourceRevisionIds: [],
    contentHash,
    supersedes: [],
  };
}
