import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { strToU8, zipSync } from "fflate";
import type { Table } from "dexie";
import { novelDb } from "./db";
import { cleanupReferenceIntegrity } from "./db-schema";
import { captureClosedLoopFixture } from "./evaluation";

const BACKUP_SCHEMA_VERSION = 13;
const BACKUP_TABLES = ["architectures", "entities", "relations", "outlineNodes", "scenes", "documents", "revisions", "manuscriptChanges", "plotThreads", "foreshadowing", "timelineEvents", "snapshots", "contextPackets", "proposals", "agentRuns", "operations", "conflicts", "skills", "projectSkills", "workflowDefinitions", "workflowRuns", "workflowArtifacts", "qualityReports", "factCandidates", "factAssertions", "knowledgeAssertions", "narrativeUnits", "outlineRealizations", "derivedMemories", "preferenceSignals", "tasteProfiles", "embeddings", "conversationThreads", "conversationMessages", "conversationMemories", "creativeBriefs", "retrievalRuns", "memoryJobs"] as const;

async function bundleProject(projectId: string) {
  const project = await novelDb.projects.get(projectId);
  if (!project) throw new Error("项目不存在");
  const data: Record<string, unknown> = { project };
  for (const tableName of BACKUP_TABLES) data[tableName] = await novelDb[tableName].where("projectId").equals(projectId).toArray();
  const tables = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, {
    count: Array.isArray(value) ? value.length : 1,
    hash: archiveValueHash(value),
  }]));
  data.manifest = { format: "ymcp-novel", schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: Date.now(), integrity: { algorithm: "fnv1a-32", tables } };
  return data;
}

function archiveValueHash(value: unknown) {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function verifyProjectArchive(payload: Record<string, unknown>) {
  const manifest = payload.manifest as { integrity?: { algorithm?: string; tables?: Record<string, { count?: number; hash?: string }> } } | undefined;
  const integrity = manifest?.integrity;
  if (!integrity) return true;
  if (integrity.algorithm !== "fnv1a-32" || !integrity.tables) throw new Error("项目归档包使用了不支持的校验格式");
  for (const [name, expected] of Object.entries(integrity.tables)) {
    const value = payload[name];
    const count = Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
    if (count !== expected.count || archiveValueHash(value) !== expected.hash) throw new Error(`项目归档包校验失败：${name}`);
  }
  return true;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stripHtml(html: string) {
  const node = document.createElement("div");
  node.innerHTML = html;
  return node.textContent ?? "";
}

async function manuscript(projectId: string) {
  const [project, documents] = await Promise.all([
    novelDb.projects.get(projectId),
    novelDb.documents.where("projectId").equals(projectId).sortBy("order"),
  ]);
  if (!project) throw new Error("项目不存在");
  return { project, chapters: documents };
}

export async function exportNovel(projectId: string, format: "json" | "markdown" | "txt" | "docx" | "epub") {
  const { project, chapters } = await manuscript(projectId);
  if (format === "json") {
    download(new Blob([JSON.stringify(await bundleProject(projectId), null, 2)], { type: "application/json" }), `${project.title}.ymcp-novel.json`);
    return;
  }
  const markdown = `# ${project.title}\n\n${chapters.map((chapter) => `## ${chapter.title}\n\n${chapter.plainText}`).join("\n\n")}`;
  if (format === "markdown" || format === "txt") {
    download(new Blob([markdown], { type: "text/plain;charset=utf-8" }), `${project.title}.${format === "markdown" ? "md" : "txt"}`);
    return;
  }
  if (format === "docx") {
    const doc = new Document({ sections: [{ children: [new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }), ...chapters.flatMap((chapter) => [new Paragraph({ text: chapter.title, heading: HeadingLevel.HEADING_1 }), ...stripHtml(chapter.contentHtml).split("\n").filter(Boolean).map((line) => new Paragraph(line))])] }] });
    download(await Packer.toBlob(doc), `${project.title}.docx`);
    return;
  }
  const chapterXhtml = chapters.map((chapter, index) => ({ name: `chapter-${index + 1}.xhtml`, title: chapter.title, body: `<h1>${chapter.title}</h1>${chapter.contentHtml}` }));
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${project.id}</dc:identifier><dc:title>${project.title}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest>${chapterXhtml.map((chapter, index) => `<item id="c${index}" href="${chapter.name}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapterXhtml.map((_, index) => `<itemref idref="c${index}"/>`).join("")}</spine></package>`),
  };
  for (const chapter of chapterXhtml) files[`OEBPS/${chapter.name}`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body>${chapter.body}</body></html>`);
  download(new Blob([zipSync(files)], { type: "application/epub+zip" }), `${project.title}.epub`);
}

export async function exportNovelEvaluationSnapshot(projectId: string) {
  const project = await novelDb.projects.get(projectId);
  if (!project) throw new Error("项目不存在");
  const fixture = await captureClosedLoopFixture(novelDb, projectId, "manual");
  download(
    new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json;charset=utf-8" }),
    `${project.title}.ymcp-evaluation.json`,
  );
}

export async function importNovel(file: File) {
  const payload = JSON.parse(await file.text()) as Record<string, unknown> & { manifest?: { format?: string; schemaVersion?: number; integrity?: { algorithm?: string; tables?: Record<string, { count?: number; hash?: string }> } }; project?: { id?: string } };
  if (payload.manifest?.format !== "ymcp-novel" || payload.manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || !payload.project?.id) throw new Error("不是有效的 Ymcp 小说项目 v13 文件");
  verifyProjectArchive(payload);
  const projectId = payload.project.id;
  const tables = ["projects", ...BACKUP_TABLES] as const;
  await novelDb.transaction("rw", novelDb.tables, async (transaction) => {
    for (const table of tables) {
      const value = table === "projects" ? [payload.project] : payload[table];
      if (!Array.isArray(value)) continue;
      const records = value as Record<string, unknown>[];
      await (novelDb[table] as unknown as Table<Record<string, unknown>, string>).bulkPut(records);
    }
    await cleanupReferenceIntegrity(transaction);
  });
  return projectId;
}
