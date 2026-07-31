export const HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE = "HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE" as const;

export interface ChapterStateRebuildConflictDetails {
  targetNarrativeOrder: number;
  laterFinalDocumentId: string;
  laterNarrativeOrder: number;
}

export class ChapterStateRebuildConflictError extends Error {
  readonly code = HISTORICAL_CHAPTER_REBUILD_REQUIRES_CASCADE;

  constructor(readonly details: ChapterStateRebuildConflictDetails) {
    super(`第 ${details.targetNarrativeOrder} 章之后仍有已定稿章节，历史章节状态重建需要级联重算`);
    this.name = "ChapterStateRebuildConflictError";
  }
}
