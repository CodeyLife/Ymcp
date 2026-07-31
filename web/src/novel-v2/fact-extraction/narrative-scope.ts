import type { MemoryClaim } from "../protocol";

export function scopeClaimsToChapter(claims: MemoryClaim[], narrativeOrder: number): MemoryClaim[] {
  if (!Number.isSafeInteger(narrativeOrder) || narrativeOrder < 1) {
    throw new Error(`章节事实必须绑定有效的 narrativeOrder，收到：${String(narrativeOrder)}`);
  }
  return claims.map((claim) => ({
    ...claim,
    narrativeRange: { start: narrativeOrder, end: narrativeOrder },
  }));
}
