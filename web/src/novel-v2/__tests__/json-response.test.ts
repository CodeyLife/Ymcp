import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../../lib/json-response";

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  it("reports an empty proxy error response without leaking JSON parse errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(requestJson("/probe")).rejects.toThrow("HTTP 500，服务未返回错误详情");
  });

  it("reports a non-JSON gateway response explicitly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 502 })));
    await expect(requestJson("/probe")).rejects.toThrow("HTTP 502，服务返回了非 JSON 响应");
  });

  it("returns a valid JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(requestJson<{ ok: boolean }>("/probe")).resolves.toEqual({ ok: true });
  });
});
