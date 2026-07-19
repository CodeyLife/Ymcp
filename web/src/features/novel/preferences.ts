import { novelDb, recordBase, type NovelDatabase } from "./db";
import type { PreferenceSignal, ProjectTasteProfile } from "./types";

type PreferenceSignalInput = Pick<PreferenceSignal, "projectId" | "sourceType" | "sourceId" | "category" | "preference" | "evidence" | "weight">;

export async function recordPreferenceSignal(params: PreferenceSignalInput, db: NovelDatabase = novelDb) {
  const signal: PreferenceSignal = { ...recordBase(params.projectId), ...params };
  await db.preferenceSignals.add(signal);
  return signal;
}

export async function buildDraftTasteProfile(projectId: string) {
  const signals = await novelDb.preferenceSignals.where("projectId").equals(projectId).toArray();
  const accepted = signals.filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
  const avoided = signals.filter((item) => item.weight < 0).sort((a, b) => a.weight - b.weight);
  const existing = await novelDb.tasteProfiles.where("projectId").equals(projectId).last();
  const profile: ProjectTasteProfile = {
    ...(existing ?? recordBase(projectId)),
    status: "draft",
    summary: signals.length ? `根据 ${signals.length} 条本项目审阅信号生成，需用户确认后才进入 AI 上下文。` : "尚无足够的项目内偏好信号。",
    preferredPatterns: [...new Set(accepted.map((item) => item.preference))].slice(0, 12),
    avoidedPatterns: [...new Set(avoided.map((item) => item.preference))].slice(0, 12),
    exemplarDocumentIds: [],
    signalIds: signals.map((item) => item.id),
    revision: (existing?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await novelDb.tasteProfiles.put(profile);
  return profile;
}

export async function confirmTasteProfile(id: string) {
  const profile = await novelDb.tasteProfiles.get(id);
  if (!profile) throw new Error("偏好配置不存在");
  await novelDb.transaction("rw", novelDb.tasteProfiles, async () => {
    const others = await novelDb.tasteProfiles.where("projectId").equals(profile.projectId).toArray();
    await Promise.all(others.filter((item) => item.id !== id && item.status === "confirmed").map((item) => novelDb.tasteProfiles.update(item.id, { status: "draft", updatedAt: Date.now() })));
    await novelDb.tasteProfiles.update(id, { status: "confirmed", revision: profile.revision + 1, updatedAt: Date.now() });
  });
}
