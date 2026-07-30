import { ModelConfigStore } from "../src/novel-v2/model-config-store";

const store = new ModelConfigStore();
const config = await store.load();
const id = process.env.NOVEL_EMBEDDING_PROFILE_ID ?? "local-bge-m3";
const profile = {
  id,
  label: "Local BGE-M3 (TEI)",
  protocol: "chat-completions" as const,
  baseUrl: process.env.NOVEL_EMBEDDING_BASE_URL ?? "http://embedding/v1",
  model: process.env.NOVEL_EMBEDDING_MODEL ?? "bge-m3",
  responseMode: "json" as const,
  capabilities: ["embedding" as const],
  enabled: true,
  timeoutMs: 120_000,
};

// Vector capabilities are endpoint-specific. Remove stale declarations from
// profiles that were previously used by memory routes before installing TEI.
const oldVectorProfileIds = new Set(
  [config.routes["memory.embed"], config.routes["memory.rerank"]]
    .flatMap((route) => route?.candidates ?? [])
    .flatMap((candidate) => candidate.executor === "api" ? [candidate.profileId] : []),
);
config.profiles = config.profiles
  .filter((item) => item.id !== id)
  .map((item) => oldVectorProfileIds.has(item.id)
    ? { ...item, capabilities: item.capabilities.filter((capability) => capability !== "embedding" && capability !== "rerank") }
    : item)
  .concat(profile);
config.routes["memory.embed"] = { conversationPolicy: "stateless", candidates: [{ executor: "api", profileId: id }] };
config.routes["memory.rerank"] = { conversationPolicy: "stateless", candidates: [{ executor: "external-mcp" }] };
await store.save(config);
console.log(JSON.stringify({ profile: id, baseUrl: profile.baseUrl, model: profile.model, embeddingRoute: config.routes["memory.embed"], rerankRoute: config.routes["memory.rerank"] }, null, 2));
