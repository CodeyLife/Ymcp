import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-config", () => ({
  getNovelApiConfig: () => ({ baseUrl: "https://example.test/v1", apiKey: "test-key", modelContextWindow: 0 }),
}));

import { callStructuredNovelModel, ROLE_PROMPTS, streamNovelModel } from "../ai";

function sse(content: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { status: 200 });
}

function unterminatedSse(content: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("novel AI HTTP handling", () => {
  it("gives every non-writer role a complete professional responsibility contract", () => {
    const roles = [
      "architect",
      "writer",
      "style-reviewer",
      "character-reviewer",
      "continuity-reviewer",
      "plot-reviewer",
      "reader-reviewer",
      "revision-editor",
      "fact-extractor",
      "quality-editor",
      "character-enricher",
      "conversation-assistant",
      "memory-curator",
      "skill-iterator",
    ] as const;

    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual([...roles].sort());
    for (const role of roles.filter((item) => item !== "writer")) {
      const prompt = ROLE_PROMPTS[role];
      expect(prompt, `${role} 缺少职责`).toContain("职责：");
      expect(prompt, `${role} 缺少专业方法`).toContain("方法：");
      expect(prompt, `${role} 缺少判断标准`).toContain("判断标准：");
      expect(prompt, `${role} 缺少职责边界`).toContain("边界：");
      expect(prompt, `${role} 缺少交付标准`).toContain("交付：");
      expect(prompt.length, `${role} 身份描述过短`).toBeGreaterThan(250);
    }
  });

  it("injects the professional role contract before stage skill instructions", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    await callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "style-reviewer",
      skillPrompt: "阶段审校规则",
      prompt: "审校正文",
      schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const systemPrompt = String(body.messages[0].content);
    expect(systemPrompt).toContain(ROLE_PROMPTS["style-reviewer"]);
    expect(systemPrompt.indexOf(ROLE_PROMPTS["style-reviewer"])).toBeLessThan(systemPrompt.indexOf("阶段审校规则"));
  });

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

  it("retries a successful stream that contains no model content", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse("正文已恢复"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = streamNovelModel({
      model: "test",
      temperature: 0,
      role: "writer",
      prompt: "继续正文",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ content: "正文已恢复" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels a long Retry-After backoff through the request signal", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "3600" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = streamNovelModel({
      model: "test",
      temperature: 0,
      role: "writer",
      prompt: "继续正文",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("用户取消", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "用户取消" });
  });

  it("consumes the final SSE event when the stream closes without a newline", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unterminatedSse("未丢失的正文"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamNovelModel({
      model: "test",
      temperature: 0,
      role: "writer",
      prompt: "继续正文",
    })).resolves.toMatchObject({ content: "未丢失的正文" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("consumes unterminated SSE content for structured responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unterminatedSse('{"value":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callStructuredNovelModel<{ value: string }>({
      model: "test",
      temperature: 0,
      role: "architect",
      prompt: "test",
      schema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    })).resolves.toMatchObject({ data: { value: "ok" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries empty stream completions via streaming until success", async () => {
    vi.useFakeTimers();
    // F-050 修复后：空内容 NovelEmptyResponseError 视为限流类错误（RATE_LIMIT_MAX_RETRIES=5），
    // 即 attempt 0-5 共 6 次请求（首次 + 5 次重试），第 6 次（attempt=5）失败后直接抛出不再重试。
    // 退避阶梯 3s/5s/8s/12s/15s 总 43s。本测试模拟 4 次空内容（attempt 0-3）+ 第 5 次（attempt=4）返回有效内容。
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse("流式恢复正文"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = streamNovelModel({
      model: "test",
      temperature: 0,
      role: "writer",
      prompt: "继续正文",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ content: "流式恢复正文" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // 所有请求均保持流式
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ stream: true });
    }
  });

  it("retries empty stream completions for structured calls via streaming fallback", async () => {
    vi.useFakeTimers();
    // 非流式降级已移除：schema strict 模式返回空内容时，降级为流式 + 去 schema 重试。
    // 第 1 次空内容 → 触发去 schema 流式降级（第 2 次请求）→ 仍空 → 外层重试 → 第 3 次成功。
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse(""))
      .mockResolvedValueOnce(sse(""))
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 所有请求均保持流式
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ stream: true });
    }
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
