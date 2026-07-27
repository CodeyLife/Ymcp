import { QdrantClient } from "@qdrant/js-client-rest";
import type { MemoryClaim, MemoryHit, MemoryProvider, RetrievalFacet } from "./protocol";
import type { ModelGateway } from "./model-gateway";

export interface MemoryIndex {
  upsertClaims(projectId: string, claims: MemoryClaim[]): Promise<void>;
}

export class QdrantMemoryProvider implements MemoryProvider, MemoryIndex {
  readonly collection: string;
  constructor(private readonly client: QdrantClient, private readonly gateway: ModelGateway, collection = process.env.QDRANT_COLLECTION ?? "novel-memory") { this.collection = collection; }

  async ensureCollection() {
    const collections = await this.client.getCollections();
    if (!collections.collections.some((item) => item.name === this.collection)) await this.client.createCollection(this.collection, { vectors: { size: Number(process.env.NOVEL_EMBEDDING_DIM ?? 1536), distance: "Cosine" } });
  }

  async search(input: { projectId: string; facets: RetrievalFacet[]; narrativeCutoff?: number; povCharacterId?: string }): Promise<MemoryHit[]> {
    await this.ensureCollection();
    const query = input.facets.map((facet) => facet.query).join(" ");
    const embedding = await this.gateway.embed({ model: process.env.NOVEL_EMBEDDING_MODEL ?? "novel-embedding", texts: [query] });
    const filter: any = { must: [{ key: "projectId", match: { value: input.projectId } }] };
    if (input.narrativeCutoff !== undefined) filter.must.push({ key: "narrativeStart", range: { lte: input.narrativeCutoff } });
    const points = await this.client.query(this.collection, { query: embedding.vectors[0], filter, limit: 64, with_payload: true });
    return points.points.map((point: any) => ({ ...(point.payload?.claim as MemoryHit), score: Number(point.score ?? 0), matchedFacet: input.facets[0]?.kind ?? "fact", reason: "qdrant dense retrieval", semanticRank: Number(point.score ?? 0) })).filter((claim: MemoryHit) => claim.id && claim.projectId === input.projectId);
  }

  async upsertClaims(projectId: string, claims: MemoryClaim[]) {
    if (!claims.length) return;
    await this.ensureCollection();
    const embeddings = await this.gateway.embed({ model: process.env.NOVEL_EMBEDDING_MODEL ?? "novel-embedding", texts: claims.map((claim) => `${claim.title}\n${claim.content}`) });
    await this.client.upsert(this.collection, {
      wait: true,
      points: claims.map((claim, index) => ({
        id: claim.id,
        vector: embeddings.vectors[index],
        payload: { projectId, narrativeStart: claim.narrativeRange?.start ?? null, kind: claim.kind, claim },
      })),
    });
  }
}
