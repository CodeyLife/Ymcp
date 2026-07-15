const detectedContextWindows = new Map<string, number>();

export function recordModelContextWindow(model: string, value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (model && Number.isFinite(parsed) && parsed > 0) detectedContextWindows.set(model, Math.floor(parsed));
}

export function resolveModelContextWindow(model: string, override?: number) {
  if (override && override > 0) return override;
  return detectedContextWindows.get(model);
}

export function estimateNovelTokens(text: string) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 4);
}

export function assertModelContextLimit(params: { model: string; text: string; override?: number; outputReserve?: number }) {
  const limit = resolveModelContextWindow(params.model, params.override);
  if (!limit) return;
  const inputEstimate = Math.ceil(estimateNovelTokens(params.text) * 1.15);
  const outputReserve = params.outputReserve ?? 4096;
  if (inputEstimate + outputReserve > limit) {
    throw new Error(`本次完整上下文预计需要 ${inputEstimate.toLocaleString()} tokens，并需为输出保留 ${outputReserve.toLocaleString()} tokens，超过模型 ${params.model} 的 ${limit.toLocaleString()} tokens 硬上限。系统没有截断必带资料，请缩小任务范围或切换更大上下文模型。`);
  }
}
