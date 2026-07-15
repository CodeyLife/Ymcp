import type { ArchitecturePhase, OutlineNode, ProposalItem } from "./types";

export type OutlineStructureIssueCode = "missing-phase" | "duplicate-order" | "invalid-proposal-item";

export interface OutlineStructureIssue {
  code: OutlineStructureIssueCode;
  nodeId: string;
  message: string;
}

export interface OutlineStructureAnalysis {
  nodes: OutlineNode[];
  invalidNodes: OutlineNode[];
  issues: OutlineStructureIssue[];
}

function phaseIdSet(phases: readonly ArchitecturePhase[] | ReadonlySet<string>) {
  return Array.isArray(phases)
    ? new Set(phases.map((phase) => phase.id))
    : new Set(phases as ReadonlySet<string>);
}

/**
 * The planning hierarchy has one structural seam: phases own plot segments.
 * Chapters are validated separately through ManuscriptDocument.plotSegmentId.
 */
export function analyzeOutlineStructure(
  nodes: readonly OutlineNode[],
  phases: readonly ArchitecturePhase[] | ReadonlySet<string>,
): OutlineStructureAnalysis {
  const validPhaseIds = phaseIdSet(phases);
  const issues: OutlineStructureIssue[] = [];
  const invalidIds = new Set<string>();

  for (const node of nodes) {
    if (!validPhaseIds.has(node.phaseId)) {
      invalidIds.add(node.id);
      issues.push({ code: "missing-phase", nodeId: node.id, message: `剧情段“${node.title}”没有归属到有效幕` });
    }
  }

  const orderGroups = new Map<string, OutlineNode[]>();
  for (const node of nodes) {
    if (invalidIds.has(node.id)) continue;
    const key = `${node.phaseId}:${node.order}`;
    orderGroups.set(key, [...(orderGroups.get(key) ?? []), node]);
  }
  for (const siblings of orderGroups.values()) {
    if (siblings.length < 2) continue;
    for (const node of siblings) {
      invalidIds.add(node.id);
      issues.push({ code: "duplicate-order", nodeId: node.id, message: `剧情段“${node.title}”与同幕其它剧情段顺序重复` });
    }
  }

  return {
    nodes: [...nodes].filter((node) => !invalidIds.has(node.id)).sort((left, right) => left.order - right.order),
    invalidNodes: [...nodes].filter((node) => invalidIds.has(node.id)),
    issues,
  };
}

export function analyzeOutlineProposal(
  items: readonly ProposalItem[],
  phases: readonly ArchitecturePhase[] | ReadonlySet<string>,
): OutlineStructureAnalysis {
  const issues: OutlineStructureIssue[] = [];
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    if (item.operation !== "create" || item.targetTable !== "outlineNodes") continue;
    const phaseId = typeof item.payload.phaseId === "string" ? item.payload.phaseId : "";
    const title = typeof item.payload.title === "string" ? item.payload.title : item.label;
    const summary = typeof item.payload.summary === "string" ? item.payload.summary : "";
    const order = Number(item.payload.order);
    if (!phaseId || !Number.isInteger(order) || order < 0) {
      issues.push({ code: "invalid-proposal-item", nodeId: item.id, message: `剧情段候选“${title}”缺少有效的幕归属或顺序` });
      continue;
    }
    const now = Date.now();
    nodes.push({
      id: item.tempId || item.id,
      projectId: "proposal",
      schemaVersion: 0,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: "proposal",
      updatedBy: "proposal",
      phaseId,
      title,
      summary,
      order,
    });
  }
  const analysis = analyzeOutlineStructure(nodes, phases);
  return { ...analysis, issues: [...issues, ...analysis.issues] };
}
