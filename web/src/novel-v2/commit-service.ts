import { randomUUID } from "node:crypto";
import type { CommitRequest, CommitResult } from "./protocol";
import { NovelPostgresRepository } from "./postgres-repository";
import { ContentObjectStore } from "./object-store";

export class CommitService {
  constructor(private readonly repository: NovelPostgresRepository, private readonly objects = new ContentObjectStore()) {}

  async commit(input: CommitRequest & { text: string }): Promise<CommitResult> {
    const independent = input.reviews.some((review) => review.identity === "independent" && review.verdict === "passed" && review.artifactFingerprint === input.artifact.fingerprint);
    const internal = input.reviews.some((review) => review.identity === "internal" && review.verdict === "passed" && review.artifactFingerprint === input.artifact.fingerprint);
    if (!independent || !internal) throw new Error("正式提交必须同时具备当前 artifact 的内部门和独立门证据");
    const object = await this.objects.putText(input.text);
    return this.repository.commitRevision({ ...input, contentHash: object.hash, objectKey: object.key, revisionId: randomUUID() });
  }
}
