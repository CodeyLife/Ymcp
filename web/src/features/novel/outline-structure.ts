import type { OutlineKind, OutlineNode, ProposalItem } from "./types";

export type OutlineStructureNode = Pick<OutlineNode, "id" | "parentId" | "kind" | "title" | "order">;

export interface OutlineStructureIssue {
  nodeId?: string;
  code:
    | "duplicate-id"
    | "cycle"
    | "act-has-parent"
    | "missing-parent"
    | "wrong-parent-kind"
    | "invalid-ancestor"
    | "duplicate-order"
    | "missing-child"
    | "invalid-operation"
    | "invalid-table"
    | "empty-outline";
  message: string;
}

export interface OutlineStructureAnalysis<T extends OutlineStructureNode> {
  roots: T[];
  validNodes: T[];
  invalidNodes: T[];
  validIds: Set<string>;
  issues: OutlineStructureIssue[];
}

export interface OutlineProposalNode extends OutlineStructureNode {
  proposalItemId: string;
  summary: string;
  status: "idea" | "planned" | "resolved";
  storyTime?: string;
  characterIds: string[];
  plotThreadIds: string[];
  foreshadowingIds: string[];
  tags: string[];
  rationale: string;
}

const EXPECTED_PARENT_KIND: Record<Exclude<OutlineKind, "act">, OutlineKind> = {
  sequence: "act",
  event: "sequence",
};

function sorted<T extends OutlineStructureNode>(nodes: T[]) {
  return [...nodes].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-CN"));
}

function cycleFor(nodeId: string, nodeMap: Map<string, OutlineStructureNode>) {
  const visited = new Set<string>();
  let current: OutlineStructureNode | undefined = nodeMap.get(nodeId);
  while (current?.parentId) {
    if (current.parentId === nodeId || visited.has(current.parentId)) return true;
    visited.add(current.parentId);
    current = nodeMap.get(current.parentId);
  }
  return false;
}

export function analyzeOutlineStructure<T extends OutlineStructureNode>(nodes: T[]): OutlineStructureAnalysis<T> {
  const issues: OutlineStructureIssue[] = [];
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) duplicateIds.add(node.id);
    seenIds.add(node.id);
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const directInvalid = new Map<string, OutlineStructureIssue>();
  for (const node of nodes) {
    let issue: OutlineStructureIssue | undefined;
    if (duplicateIds.has(node.id)) {
      issue = { nodeId: node.id, code: "duplicate-id", message: "节点 ID 重复" };
    } else if (cycleFor(node.id, nodeMap)) {
      issue = { nodeId: node.id, code: "cycle", message: "父子关系存在循环引用" };
    } else if (node.kind === "act" && node.parentId) {
      issue = { nodeId: node.id, code: "act-has-parent", message: "幕必须位于大纲根级，不能拥有父节点" };
    } else if (node.kind !== "act") {
      const parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
      if (!node.parentId || !parent) {
        issue = { nodeId: node.id, code: "missing-parent", message: `${node.kind === "sequence" ? "序列" : "事件"}缺少有效父节点` };
      } else if (parent.kind !== EXPECTED_PARENT_KIND[node.kind]) {
        issue = {
          nodeId: node.id,
          code: "wrong-parent-kind",
          message: node.kind === "sequence" ? "序列必须归属于幕" : "事件必须归属于序列",
        };
      }
    }
    if (issue) directInvalid.set(node.id, issue);
  }

  const validity = new Map<string, boolean>();
  const isValid = (nodeId: string): boolean => {
    const cached = validity.get(nodeId);
    if (cached !== undefined) return cached;
    if (directInvalid.has(nodeId)) {
      validity.set(nodeId, false);
      return false;
    }
    const node = nodeMap.get(nodeId);
    if (!node) return false;
    if (!node.parentId) {
      const validRoot = node.kind === "act";
      validity.set(nodeId, validRoot);
      return validRoot;
    }
    validity.set(nodeId, false);
    const valid = isValid(node.parentId);
    validity.set(nodeId, valid);
    return valid;
  };

  const validIds = new Set(nodes.filter((node) => isValid(node.id)).map((node) => node.id));
  const invalidNodes = nodes.filter((node) => !validIds.has(node.id));
  for (const node of invalidNodes) {
    issues.push(directInvalid.get(node.id) ?? {
      nodeId: node.id,
      code: "invalid-ancestor",
      message: "上级节点结构无效，当前节点无法进入大纲树",
    });
  }

  const orderGroups = new Map<string, T[]>();
  for (const node of nodes.filter((item) => validIds.has(item.id))) {
    const key = `${node.parentId ?? "root"}:${node.kind}:${node.order}`;
    const group = orderGroups.get(key) ?? [];
    group.push(node);
    orderGroups.set(key, group);
  }
  for (const group of orderGroups.values()) {
    if (group.length < 2) continue;
    for (const node of group) {
      issues.push({ nodeId: node.id, code: "duplicate-order", message: "同级节点顺序重复，需要重新排序" });
    }
  }

  const validNodes = nodes.filter((node) => validIds.has(node.id));
  return {
    roots: sorted(validNodes.filter((node) => node.kind === "act" && !node.parentId)),
    validNodes,
    invalidNodes,
    validIds,
    issues,
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function proposalNode(item: ProposalItem): OutlineProposalNode {
  const payload = item.after ?? item.payload;
  const rawParentId = typeof payload.parentId === "string" ? payload.parentId.trim() : "";
  return {
    id: item.tempId?.trim() || item.id,
    parentId: rawParentId ? (rawParentId.startsWith("ref:") ? rawParentId.slice(4) : rawParentId) : undefined,
    kind: payload.kind as OutlineKind,
    title: String(payload.title || item.label || "未命名节点"),
    summary: String(payload.summary || ""),
    order: numberValue(payload.order, 0),
    status: payload.status === "planned" || payload.status === "resolved" ? payload.status : "idea",
    storyTime: typeof payload.storyTime === "string" ? payload.storyTime : undefined,
    characterIds: stringArray(payload.characterIds),
    plotThreadIds: stringArray(payload.plotThreadIds),
    foreshadowingIds: stringArray(payload.foreshadowingIds),
    tags: stringArray(payload.tags),
    rationale: item.rationale,
    proposalItemId: item.id,
  };
}

export function analyzeOutlineProposal(items: ProposalItem[], requireComplete = true) {
  const issues: OutlineStructureIssue[] = [];
  const outlineItems = items.filter((item) => {
    if (item.targetTable !== "outlineNodes") {
      issues.push({ nodeId: item.id, code: "invalid-table", message: "完整大纲只能包含大纲节点" });
      return false;
    }
    if (item.operation !== "create") {
      issues.push({ nodeId: item.id, code: "invalid-operation", message: "完整大纲必须以新树整体替换，不能混用更新操作" });
      return false;
    }
    return true;
  });
  const nodes = outlineItems.map(proposalNode);
  if (!nodes.length) issues.push({ code: "empty-outline", message: "候选大纲没有可采纳节点" });
  const analysis = analyzeOutlineStructure(nodes);
  issues.push(...analysis.issues);

  if (requireComplete) {
    const childKinds = new Map<string, Set<OutlineKind>>();
    for (const node of analysis.validNodes) {
      if (!node.parentId) continue;
      const kinds = childKinds.get(node.parentId) ?? new Set<OutlineKind>();
      kinds.add(node.kind);
      childKinds.set(node.parentId, kinds);
    }
    for (const node of analysis.validNodes) {
      if (node.kind === "act" && !childKinds.get(node.id)?.has("sequence")) {
        issues.push({ nodeId: node.id, code: "missing-child", message: `幕“${node.title}”至少需要一个序列` });
      }
      if (node.kind === "sequence" && !childKinds.get(node.id)?.has("event")) {
        issues.push({ nodeId: node.id, code: "missing-child", message: `序列“${node.title}”至少需要一个事件` });
      }
    }
  }

  return { ...analysis, nodes, issues };
}
