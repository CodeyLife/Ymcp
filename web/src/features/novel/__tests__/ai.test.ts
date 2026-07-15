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

  it("passes the structured output token limit to the chat completion request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    await callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "architect",
      prompt: "generate",
      schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      maxTokens: 8192,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ max_tokens: 8192 });
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

  it("repair prompt forbids summary from describing the schema fix", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse('{"other":"bad"}'))
      .mockResolvedValueOnce(sse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    await callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "architect",
      prompt: "test",
      schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const repairPrompt = String(repairBody.messages[1].content);
    expect(repairPrompt).toContain("summary 字段只写候选整体概览");
    expect(repairPrompt).toContain("禁止描述修复过程");
    expect(repairPrompt).toContain("Schema 约束");
  });
});
