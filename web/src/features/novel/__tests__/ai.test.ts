import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/stores/ui", () => ({
  getEffectiveApiConfig: () => ({ baseUrl: "https://example.test/v1", apiKey: "test-key" }),
}));

import { callStructuredNovelModel } from "../ai";

function sse(content: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("novel AI HTTP handling", () => {
  it("falls back without response_format when the server returns a JSON 400 body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "json_schema unsupported" } }), { status: 400 }))
      .mockResolvedValueOnce(sse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "architect",
      prompt: "test",
      schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    });

    expect(result.data).toEqual({ value: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty("response_format");
  });

  it("retries a JSON 429 response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
      .mockResolvedValueOnce(sse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    const pending = callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "architect",
      prompt: "test",
      schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ data: { value: "ok" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
