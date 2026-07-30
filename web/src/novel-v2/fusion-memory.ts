/**
 * P2-G2 三轨加权融合 MemoryProvider：semantic (Qdrant) + lexical (Postgres) + graph。
 *
 * 设计依据：AGENTS.md「Fix the problem at the lowest shared layer that owns the
 * faulty behavior. Prefer reusable contracts over case-specific logic.」
 *
 * 根因分析：
 * - 症状：检索结果排序质量不稳定，部分高相关 lexical 命中被 semantic 低分 claim 挤出。
 * - 失败层：融合策略——原实现（worker 内联）用 `[...new Map([...semantic, ...lexical])]`
 *   做 last-wins 去重，lexical 覆盖 semantic 的 score（或反之），未做加权合并。
 * - 机制：两条独立召回轨道（dense embedding vs ILIKE）对同一 claim 给出不同尺度的分数，
 *   简单覆盖会丢失另一轨道的信号；scale 不一致（Qdrant cosine ∈ [0,1]，Postgres
 *   lexicalRank∈[0,1] 但加权后 score∈[0,1]）也无法直接比较。
 * - 受影响输入类：所有 multi-facet 检索（drafting/revision 任务），尤其是 POV 角色
 *   档案、伏笔、前章摘要等在两个轨道都有命中的 claim。
 *
 * 解决方案：
 * - 每条轨道分数先做 min-max 归一化到 [0,1]（消除尺度差异）。
 * - 同一 claim 在多轨道出现时，按权重融合：semantic 0.5 + lexical 0.3 + graph 0.2。
 * - 缺失轨道时权重重分配（无 graph → semantic 0.625 + lexical 0.375），
 *   避免 graph 未接入时 score 整体偏低。
 * - 保留 semanticRank/lexicalRank/graphRank 字段供下游可观测。
 *
 * 边界（本方案不覆盖）：
 * - 不实现 graph 轨道本身（GraphMemoryProvider 由后续 Phase 接入），但预留接口。
 * - 不改变各轨道的召回逻辑（Qdrant/Postgres 各自维护自己的过滤与截断）。
 * - 不解决单轨道内部的重排序（rerank 仍在 QdrantMemoryProvider 内完成）。
 */
import type {
  MemoryHit,
  MemoryProvider,
  RetrievalFacet,
} from "./protocol";
import type { NovelPostgresRepository } from "./postgres-repository";

export interface FusionMemoryProviderOptions {
  /** 语义检索轨道（Qdrant dense retrieval + rerank）。 */
  semantic: MemoryProvider;
  /** 词法检索轨道（Postgres ILIKE + lexicalRank）。 */
  lexical: { search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> };
  /** 图检索轨道（可选，relations/entities BFS/DFS，未来 Phase 接入）。 */
  graph?: { search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> };
  /**
   * 轨道权重（归一化后使用，缺失轨道的权重会按比例重分配到其他轨道）。
   * 默认 semantic 0.5 / lexical 0.3 / graph 0.2。
   */
  weights?: { semantic?: number; lexical?: number; graph?: number };
  /** 单 facet 内每轨道召回上限（避免某轨道爆量）。默认 32。 */
  perTrackLimit?: number;
  /** 融合后的候选上限；最终注入数量由 MemoryBundle token 预算决定。默认 96。 */
  candidateLimit?: number;
}

const DEFAULT_WEIGHTS = { semantic: 0.5, lexical: 0.3, graph: 0.2 };

/**
 * 对单轨道分数做 min-max 归一化到 [0,1]。
 *
 * - 所有分数相同（含全 0）时返回均匀分布 1/n，避免除零并保留召回信号。
 * - 不改变原数组，返回新数组。
 */
function normalizeScores(hits: MemoryHit[]): MemoryHit[] {
  if (hits.length === 0) return hits;
  const scores = hits.map((hit) => Number(hit.score) || 0);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) {
    // 全相同：均匀分布，保留全部召回（不归零，否则会丢信号）
    const uniform = 1 / hits.length;
    return hits.map((hit) => ({ ...hit, score: uniform }));
  }
  return hits.map((hit, idx) => ({ ...hit, score: (scores[idx] - min) / range }));
}

export class FusionMemoryProvider implements MemoryProvider {
  constructor(private readonly options: FusionMemoryProviderOptions) {}

  async search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    const weights = { ...DEFAULT_WEIGHTS, ...this.options.weights };
    const perTrackLimit = this.options.perTrackLimit ?? 32;
    const candidateLimit = this.options.candidateLimit ?? 96;

    // 并行召回三轨（graph 可选，缺失时跳过）
    const tracks: Array<{ name: "semantic" | "lexical" | "graph"; weight: number; hits: MemoryHit[] }> = [];

    const [semanticHits, lexicalHits, graphHits] = await Promise.all([
      this.options.semantic.search(input).then((hits) => hits.slice(0, perTrackLimit)).catch((error: unknown) => {
        // 语义轨道失败（Qdrant 不可用）→ 降级为仅 lexical，不阻塞
        console.warn("[FusionMemoryProvider] 语义检索失败，降级为词法单轨", error);
        return [] as MemoryHit[];
      }),
      Promise.resolve(this.options.lexical).then((lex) => lex.search(input)).then((hits) => hits.slice(0, perTrackLimit)).catch((error: unknown) => {
        console.warn("[FusionMemoryProvider] 词法检索失败", error);
        return [] as MemoryHit[];
      }),
      this.options.graph
        ? this.options.graph.search(input).then((hits) => hits.slice(0, perTrackLimit)).catch((error: unknown) => {
            console.warn("[FusionMemoryProvider] 图检索失败", error);
            return [] as MemoryHit[];
          })
        : Promise.resolve([] as MemoryHit[]),
    ]);

    if (semanticHits.length > 0) tracks.push({ name: "semantic", weight: weights.semantic, hits: normalizeScores(semanticHits) });
    if (lexicalHits.length > 0) tracks.push({ name: "lexical", weight: weights.lexical, hits: normalizeScores(lexicalHits) });
    if (graphHits.length > 0) tracks.push({ name: "graph", weight: weights.graph, hits: normalizeScores(graphHits) });

    // 无任何召回（两/三轨全空）→ 返回空，让 buildMemoryBundle 走 missingFacets 逻辑
    if (tracks.length === 0) return [];

    // 权重重分配：缺失轨道的权重按比例分给在场轨道
    const totalWeight = tracks.reduce((sum, track) => sum + track.weight, 0);
    const redistributed = tracks.map((track) => ({ ...track, weight: track.weight / totalWeight }));

    // 融合：同一 claim id 在多轨道出现时，按重分配后的权重加权求和
    const fused = new Map<string, MemoryHit>();
    for (const track of redistributed) {
      for (const hit of track.hits) {
        const existing = fused.get(hit.id);
        if (existing) {
          // 多轨道命中：加权累加 score，合并 reason，保留各 rank 字段
          const mergedScore = Number(existing.score) + track.weight * Number(hit.score);
          const rankField = track.name === "semantic" ? "semanticRank" : track.name === "lexical" ? "lexicalRank" : "graphRank";
          fused.set(hit.id, {
            ...existing,
            score: mergedScore,
            matchedFacets: [...new Set([
              ...(existing.matchedFacets ?? [existing.matchedFacet]),
              ...(hit.matchedFacets ?? [hit.matchedFacet]),
            ])],
            reason: `${existing.reason} | ${track.name}:${Number(hit.score).toFixed(3)}`,
            [rankField]: Number(hit.score),
          });
        } else {
          // 单轨道命中：score = weight * normalizedScore
          const rankField = track.name === "semantic" ? "semanticRank" : track.name === "lexical" ? "lexicalRank" : "graphRank";
          fused.set(hit.id, {
            ...hit,
            matchedFacets: hit.matchedFacets ?? [hit.matchedFacet],
            score: track.weight * Number(hit.score),
            reason: `${track.name}:${Number(hit.score).toFixed(3)}`,
            [rankField]: Number(hit.score),
          });
        }
      }
    }

    // 这里只限制候选规模；最终注入由 buildMemoryBundle 按 facet coverage + token budget 决定。
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, candidateLimit);
  }
}

/**
 * 工厂：从 repository + qdrant provider 构造 FusionMemoryProvider。
 * 保留 lexical 回退语义（Qdrant 全失败时仍返回 lexical 结果）。
 */
export function createFusionMemoryProvider(
  semantic: MemoryProvider,
  lexical: Pick<NovelPostgresRepository, "searchMemory">,
  graph?: FusionMemoryProviderOptions["graph"],
  weights?: FusionMemoryProviderOptions["weights"],
): FusionMemoryProvider {
  return new FusionMemoryProvider({
    semantic,
    lexical: { search: (input) => lexical.searchMemory(input) },
    graph,
    weights,
  });
}
