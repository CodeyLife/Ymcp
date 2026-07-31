import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import type { MemoryClaim, MemoryHit, MemoryProvider, RetrievalFacet } from "./protocol";
import type { ModelGateway } from "./model-gateway";

export interface MemoryIndex {
  upsertClaims(projectId: string, claims: MemoryClaim[]): Promise<void>;
  deleteClaims?(projectId: string, claimIds: string[]): Promise<void>;
}

/**
 * 通过 claim.id 前缀识别 chapter memory（由 chapter-memory/index.ts 的 chapterMemoryAsClaim 产出）。
 *
 * 设计依据：Phase 1.2 chapter memory 索引——chapter memory 投影为 MemoryClaim 时
 * id 格式为 `memory:chapter:${revisionId}`，通过此前缀在 Qdrant 检索结果中识别并
 * 标记 matchedFacet="chapter-memory"，让 buildMemoryBundle 能正确计算 missingFacets。
 */
const CHAPTER_MEMORY_ID_PREFIX = "memory:chapter:";

export function qdrantPointId(projectId: string, claimId: string): string {
  const bytes = createHash("sha256").update(projectId).update("\0").update(claimId).digest().subarray(0, 16);
  // RFC 9562 UUIDv8: deterministic application-defined content with the standard variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class QdrantMemoryProvider implements MemoryProvider, MemoryIndex {
  readonly collection: string;
  readonly dimension: number;
  constructor(private readonly client: QdrantClient, private readonly gateway: ModelGateway, collection = process.env.QDRANT_COLLECTION ?? "novel-memory", dimension = Number(process.env.NOVEL_EMBEDDING_DIM ?? 1024)) { this.collection = collection; this.dimension = dimension; }

  async ensureCollection() {
    let info: Awaited<ReturnType<QdrantClient["getCollection"]>>;
    try {
      // getCollection resolves aliases as well as physical collection names.
      info = await this.client.getCollection(this.collection);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
      await this.client.createCollection(this.collection, { vectors: { size: this.dimension, distance: "Cosine" } });
      return;
    }
    const vectors = info.config?.params?.vectors as { size?: number } | undefined;
    if (Number(vectors?.size) !== this.dimension) throw new Error(`Qdrant 集合 ${this.collection} 维度 ${String(vectors?.size)} 与 embedding 维度 ${this.dimension} 不一致`);
  }

  async search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    await this.ensureCollection();
    const query = input.facets.map((facet) => facet.query).join(" ");
    const embedding = await this.gateway.embed({ purpose: "memory.embed", texts: [query] });
    if (embedding.vectors[0]?.length !== this.dimension) throw new Error(`查询向量维度 ${embedding.vectors[0]?.length ?? 0} 与集合维度 ${this.dimension} 不一致`);
    const filter: any = { must: [
      { key: "projectId", match: { value: input.projectId } },
      { key: "lifecycleStatus", match: { value: "active" } },
    ] };
    // P0-A4: narrativeStart=null 表示全局可见（无章节归属的基础事实），
    // 不应被 narrativeCutoff 屏蔽。Qdrant 的 range:lte 过滤会排除 null 值，
    // 因此改用 should（OR）组合：narrativeStart <= cutoff OR narrativeStart IS NULL。
    // 设计依据：AGENTS.md「root-cause analysis」——null 语义是"全局可见"，
    // 被错误屏蔽会导致大量基础事实在检索时丢失。
    if (input.narrativeCutoff !== undefined) {
      filter.must.push({
        should: [
          { key: "narrativeStart", range: { lte: input.narrativeCutoff } },
          { key: "narrativeStart", is_null: true },
        ],
      });
    }
    // P0-A2: POV 角色知识边界过滤
    // 设计依据：AGENTS.md「reusable contracts」——POV 角色不应知道其他角色的秘密。
    // knowledgeScope="author" 是全局可见事实，总是召回；
    // knowledgeScope={characterId} 只在 characterId === povCharacterId 时召回。
    // Qdrant payload 中存储 knowledgeScopeCharacterId（upsertClaims 时填充）。
    if (input.povCharacterId) {
      filter.must.push({
        should: [
          { key: "knowledgeScopeCharacterId", is_null: true },
          { key: "knowledgeScopeCharacterId", match: { value: input.povCharacterId } },
        ],
      });
    }
    const points = await this.client.query(this.collection, { query: embedding.vectors[0], filter, limit: 64, with_payload: true });
    const facetKinds = new Set(input.facets.map((facet) => facet.kind));
    const hits = points.points
      .map((point: any) => {
        const claim = point.payload?.claim as MemoryHit | undefined;
        if (!claim || !claim.id || claim.projectId !== input.projectId || claim.lifecycleStatus === "staged" || !["approved", "author", "derived"].includes(claim.authority)) return null;
        // P0-A5: matchedFacet 按 claim.kind 匹配 facet 列表，而非强制标记为 facets[0].kind
        // 设计依据：AGENTS.md「root-cause analysis」——matchedFacet 错标会导致 missingFacets
        // 计算错误，高风险任务可能因 missingFacets.length && risk==="high" 抛错阻断生成。
        // chapter memory 通过 id 前缀识别，优先标记为 "chapter-memory"。
        let matchedFacet: RetrievalFacet["kind"];
        if (claim.id.startsWith(CHAPTER_MEMORY_ID_PREFIX)) {
          matchedFacet = "chapter-memory";
        } else if (facetKinds.has(claim.kind as RetrievalFacet["kind"])) {
          // claim.kind 在 facet 列表中，用它标记
          matchedFacet = claim.kind as RetrievalFacet["kind"];
        } else {
          // claim.kind 不在 facet 列表中（如 episodic claim 被 foreshadowing facet 召回），
          // 标记为第一个匹配的 facet kind 作为 fallback
          matchedFacet = input.facets[0]?.kind ?? "fact";
        }
        return {
          ...claim,
          score: Number(point.score ?? 0),
          matchedFacet,
          matchedFacets: [matchedFacet],
          reason: "qdrant dense retrieval",
          semanticRank: Number(point.score ?? 0),
        } as MemoryHit;
      })
      .filter((claim: MemoryHit | null): claim is MemoryHit => claim !== null);

    // P0-A1: 过滤被 supersedes 的旧 claim（retrieval 层屏蔽）
    // 设计依据：AGENTS.md「root-cause analysis」——supersedes 是长程一致性核心契约，
    // 旧版本和新版本 claim 不能同时出现，否则 LLM 会看到自相矛盾的事实。
    // Qdrant 不支持数组包含过滤的复杂语义，这里在应用层过滤。
    const supersededIds = new Set(hits.flatMap((hit) => hit.supersedes ?? []));
    const filteredHits = supersededIds.size > 0 ? hits.filter((hit) => !supersededIds.has(hit.id)) : hits;

    // Phase 2.1 rerank：若 gateway.rerank 可用，对 top-N 做 cross-encoder rerank
    return this.applyRerank(query, filteredHits);
  }

  /**
   * 对 Qdrant 召回结果做 rerank 精排。
   *
   * - 输入：query + 已召回的 hits（limit=64）
   * - 输出：top-K（K=32）按 rerank score 降序
   * - 失败/不可用：降级为原 semanticRank 顺序，只截断到 top-32
   *
   * 设计依据：Phase 2.1 计划——rerank score 覆盖 semanticRank，
   * 让 buildMemoryBundle 的后续排序逻辑无需感知 rerank 存在。
   */
  private async applyRerank(query: string, hits: MemoryHit[]): Promise<MemoryHit[]> {
    const TOP_N = 64;
    const TOP_K = 32;
    if (hits.length === 0) return hits;

    // 截断到 TOP_N（Qdrant 已 limit=64，这里冗余保护）
    const candidates = hits.slice(0, TOP_N);

    try {
      const documents = candidates.map((hit) => `${hit.title}\n${hit.content}`);
      const rerankResult = await this.gateway.rerank({ purpose: "memory.rerank", query, documents });
      const scores = rerankResult.scores;
      if (scores.length !== candidates.length) {
        // scores 数量不匹配，降级
        return candidates.slice(0, TOP_K);
      }
      // 按 rerank score 降序排序，覆盖 semanticRank
      const reranked = candidates
        .map((hit, index) => ({ hit, rerankScore: Number(scores[index] ?? 0) }))
        .sort((a, b) => b.rerankScore - a.rerankScore)
        .slice(0, TOP_K)
        .map((entry) => ({
          ...entry.hit,
          score: entry.rerankScore,
          semanticRank: entry.rerankScore,
          reason: "qdrant dense + rerank",
        }));
      return reranked;
    } catch {
      // rerank 失败（模型不可用/超时/参数错误）→ 降级为纯 Qdrant score 顺序
      return candidates.slice(0, TOP_K);
    }
  }

  async upsertClaims(projectId: string, claims: MemoryClaim[]) {
    if (!claims.length) return;
    await this.ensureCollection();
    const supersededIds = [...new Set(claims.flatMap((claim) => claim.supersedes))];
    if (supersededIds.length) await this.deleteClaims(projectId, supersededIds);
    const embeddings = await this.gateway.embed({ purpose: "memory.embed", texts: claims.map((claim) => `${claim.title}\n${claim.content}`) });
    if (embeddings.vectors.length !== claims.length || embeddings.vectors.some((vector) => vector.length !== this.dimension)) {
      throw new Error(`embedding 返回 ${embeddings.vectors.length} 个向量，要求 ${claims.length} 个且每个维度为 ${this.dimension}`);
    }
    await this.client.upsert(this.collection, {
      wait: true,
      points: claims.map((claim, index) => ({
        id: qdrantPointId(projectId, claim.id),
        vector: embeddings.vectors[index],
        payload: {
          projectId,
          authority: claim.authority,
          lifecycleStatus: claim.lifecycleStatus ?? "active",
          narrativeStart: claim.narrativeRange?.start ?? null,
          kind: claim.kind,
          // P0-A2: 存储 knowledgeScopeCharacterId 用于 POV 知识边界过滤
          // knowledgeScope="author" 时为 null（全局可见），{characterId} 时为该 characterId
          knowledgeScopeCharacterId: typeof claim.knowledgeScope === "object" && claim.knowledgeScope !== null
            ? claim.knowledgeScope.characterId
            : null,
          claim,
        },
      })),
    });
  }

  async deleteClaims(projectId: string, claimIds: string[]) {
    if (!claimIds.length) return;
    await this.ensureCollection();
    await this.client.delete(this.collection, {
      wait: true,
      points: [...new Set(claimIds)].map((claimId) => qdrantPointId(projectId, claimId)),
    });
  }
}
