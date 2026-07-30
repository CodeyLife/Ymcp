function errorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown;
  if (!text.trim()) {
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}，服务未返回错误详情`);
    throw new Error(`请求失败：HTTP ${response.status}，服务返回空响应`);
  }
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`请求失败：HTTP ${response.status}，服务返回了非 JSON 响应`);
  }
  if (!response.ok) throw new Error(errorMessage(body) ?? `请求失败：HTTP ${response.status}`);
  return body as T;
}
