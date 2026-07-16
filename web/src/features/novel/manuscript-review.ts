import { documentContentHash, novelDb, recordBase, saveApprovedDocumentRevision } from "./db";
import type { DocumentRevision, ManuscriptBlock, ManuscriptChange, ManuscriptDocument } from "./types";

export function manuscriptTextHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function paragraphs(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized ? normalized.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean) : [];
}

function blocksFromText(text: string, idFor: (text: string, order: number) => string): ManuscriptBlock[] {
  return paragraphs(text).map((paragraph, order) => ({ id: idFor(paragraph, order), order, text: paragraph, kind: "paragraph" }));
}

function lcsMatches(base: ManuscriptBlock[], proposed: string[]) {
  const lengths = Array.from({ length: base.length + 1 }, () => Array<number>(proposed.length + 1).fill(0));
  for (let left = base.length - 1; left >= 0; left -= 1) {
    for (let right = proposed.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = base[left].text === proposed[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  const matches: Array<[number, number]> = [];
  let left = 0;
  let right = 0;
  while (left < base.length && right < proposed.length) {
    if (base[left].text === proposed[right]) {
      matches.push([left, right]);
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) left += 1;
    else right += 1;
  }
  return matches;
}

export function planManuscriptChanges(
  baseBlocks: ManuscriptBlock[],
  proposedText: string,
  createId: () => string = () => crypto.randomUUID(),
) {
  const proposed = paragraphs(proposedText);
  const matches = [[-1, -1] as [number, number], ...lcsMatches(baseBlocks, proposed), [baseBlocks.length, proposed.length] as [number, number]];
  const changes: Array<Omit<ManuscriptChange, keyof ReturnType<typeof recordBase> | "projectId" | "documentId" | "baseDocumentRevision" | "baseContentHash" | "sourceContentHash" | "status">> = [];
  const output: ManuscriptBlock[] = [];

  for (let segment = 0; segment < matches.length - 1; segment += 1) {
    const [baseStart, proposedStart] = matches[segment];
    const [baseEnd, proposedEnd] = matches[segment + 1];
    const removed = baseBlocks.slice(baseStart + 1, baseEnd);
    const added = proposed.slice(proposedStart + 1, proposedEnd);
    const paired = Math.min(removed.length, added.length);
    for (let index = 0; index < paired; index += 1) {
      const before = removed[index];
      output.push({ ...before, order: proposedStart + 1 + index, text: added[index] });
      changes.push({
        operation: "replace",
        targetBlockId: before.id,
        proposedBlockId: before.id,
        order: proposedStart + 1 + index,
        beforeText: before.text,
        afterText: added[index],
        beforeTextHash: manuscriptTextHash(before.text),
      });
    }
    for (let index = paired; index < removed.length; index += 1) {
      const before = removed[index];
      changes.push({
        operation: "delete",
        targetBlockId: before.id,
        proposedBlockId: before.id,
        order: proposedStart + 1 + paired,
        beforeText: before.text,
        beforeTextHash: manuscriptTextHash(before.text),
      });
    }
    for (let index = paired; index < added.length; index += 1) {
      const id = createId();
      const order = proposedStart + 1 + index;
      output.push({ id, order, text: added[index], kind: "paragraph" });
      changes.push({ operation: "insert", proposedBlockId: id, order, afterText: added[index] });
    }
    if (baseEnd < baseBlocks.length) output.push({ ...baseBlocks[baseEnd], order: proposedEnd });
  }
  return { changes, proposedBlocks: output.sort((a, b) => a.order - b.order).map((block, order) => ({ ...block, order })) };
}

function revisionBlocks(document: ManuscriptDocument, revision?: DocumentRevision): ManuscriptBlock[] {
  const seed = revision?.blocks?.length
    ? revision.blocks
    : blocksFromText(revision?.plainText ?? document.plainText, (text, order) => `paragraph:${revision?.id ?? document.id}:${order}:${manuscriptTextHash(text)}`);
  if (!revision || revision.plainText === document.plainText) return seed.map((block, order) => ({ ...block, order }));
  return planManuscriptChanges(seed, document.plainText).proposedBlocks;
}

export async function prepareManuscriptChanges(params: {
  projectId: string;
  documentId: string;
  proposedText: string;
  workflowRunId?: string;
  sourceArtifactId?: string;
}) {
  const document = await novelDb.documents.get(params.documentId);
  if (!document || document.projectId !== params.projectId) throw new Error("章节不存在");
  const revision = document.approvedRevisionId ? await novelDb.revisions.get(document.approvedRevisionId) : undefined;
  const baseContentHash = documentContentHash(document);
  const sourceContentHash = manuscriptTextHash(params.proposedText);
  const planned = planManuscriptChanges(revisionBlocks(document, revision), params.proposedText);
  const now = Date.now();
  const records: ManuscriptChange[] = planned.changes.map((change) => ({
    ...recordBase(document.projectId),
    ...change,
    documentId: document.id,
    workflowRunId: params.workflowRunId,
    sourceArtifactId: params.sourceArtifactId,
    baseRevisionId: document.approvedRevisionId,
    baseDocumentRevision: document.revision,
    baseContentHash,
    sourceContentHash,
    status: "pending",
  }));
  return novelDb.transaction("rw", novelDb.manuscriptChanges, async () => {
    const existing = await novelDb.manuscriptChanges.where("documentId").equals(document.id).filter((change) =>
      change.sourceArtifactId === params.sourceArtifactId
      && change.baseDocumentRevision === document.revision
      && change.baseContentHash === baseContentHash
      && change.sourceContentHash === sourceContentHash).toArray();
    if (existing.length) return existing.sort((a, b) => a.order - b.order);
    const stale = await novelDb.manuscriptChanges.where("documentId").equals(document.id).filter((change) => change.status === "pending" && change.sourceArtifactId !== params.sourceArtifactId).toArray();
    if (stale.length) await novelDb.manuscriptChanges.where("id").anyOf(stale.map((change) => change.id)).modify({ status: "rejected", decidedAt: now, updatedAt: now });
    if (records.length) await novelDb.manuscriptChanges.bulkAdd(records);
    return records;
  });
}

export async function updateManuscriptChangeText(changeId: string, afterText: string) {
  const change = await novelDb.manuscriptChanges.get(changeId);
  if (!change || change.status !== "pending" || change.operation === "delete") throw new Error("该段落变更已不可编辑");
  await novelDb.manuscriptChanges.update(changeId, { afterText, revision: change.revision + 1, updatedAt: Date.now(), updatedBy: "local-user" });
}

// Loop 8 修复 #14：导出 toHtml 供 commit-stage 同步 contentHtml
export function toHtml(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return paragraphs(text).map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
}

export async function applyManuscriptChanges(params: {
  documentId: string;
  sourceArtifactId: string;
  selectedChangeIds: string[];
  label: string;
}) {
  const document = await novelDb.documents.get(params.documentId);
  if (!document) throw new Error("章节不存在");
  const changes = await novelDb.manuscriptChanges.where("documentId").equals(document.id)
    .filter((change) => change.sourceArtifactId === params.sourceArtifactId && change.status === "pending")
    .sortBy("order");
  if (changes.length && !params.selectedChangeIds.length) throw new Error("请至少采纳一个段落变更，或退回正文修改");
  const baseline = changes[0];
  if (baseline && (document.revision !== baseline.baseDocumentRevision
    || document.approvedRevisionId !== baseline.baseRevisionId
    || documentContentHash(document) !== baseline.baseContentHash)) {
    const now = Date.now();
    await novelDb.manuscriptChanges.where("id").anyOf(changes.map((change) => change.id)).modify({ status: "conflict", updatedAt: now, updatedBy: "local-user" });
    throw new Error("正文基线已发生变化，请重新生成逐段审阅");
  }
  const revision = document.approvedRevisionId ? await novelDb.revisions.get(document.approvedRevisionId) : undefined;
  let blocks = revisionBlocks(document, revision);
  const selected = new Set(params.selectedChangeIds);
  const accepted = changes.filter((change) => selected.has(change.id));
  for (const change of accepted.filter((item) => item.operation !== "insert")) {
    const index = blocks.findIndex((block) => block.id === change.targetBlockId);
    if (index < 0 || manuscriptTextHash(blocks[index].text) !== change.beforeTextHash) {
      const now = Date.now();
      await novelDb.manuscriptChanges.where("id").anyOf(changes.map((item) => item.id)).modify({ status: "conflict", updatedAt: now, updatedBy: "local-user" });
      throw new Error("目标段落已发生变化，请重新生成逐段审阅");
    }
    if (change.operation === "delete") blocks.splice(index, 1);
    else blocks[index] = { ...blocks[index], text: change.afterText ?? "" };
  }
  for (const change of accepted.filter((item) => item.operation === "insert").sort((a, b) => a.order - b.order)) {
    blocks.splice(Math.min(change.order, blocks.length), 0, { id: change.proposedBlockId, order: change.order, text: change.afterText ?? "", kind: "paragraph" });
  }
  blocks = blocks.filter((block) => block.text.trim()).map((block, order) => ({ ...block, order }));
  const plainText = blocks.map((block) => block.text).join("\n\n");
  return saveApprovedDocumentRevision({
    ...document,
    plainText,
    contentHtml: toHtml(plainText),
    wordCount: (plainText.match(/[\u3400-\u9fff]|[a-zA-Z0-9]+/g) ?? []).length,
    status: "review",
  }, params.label, "ai", {
    blocks,
    expected: {
      documentRevision: baseline?.baseDocumentRevision ?? document.revision,
      contentHash: baseline?.baseContentHash ?? documentContentHash(document),
      approvedRevisionId: baseline?.baseRevisionId ?? document.approvedRevisionId,
    },
    acceptedChangeIds: accepted.map((change) => change.id),
    rejectedChangeIds: changes.filter((change) => !selected.has(change.id)).map((change) => change.id),
  });
}
