export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));

  return results;
}
