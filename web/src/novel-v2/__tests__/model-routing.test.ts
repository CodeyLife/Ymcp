import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfigStore, applyRuntimeModelOverrides } from "../model-config-store";
import { normalizeProviderJsonSchema, RoutedModelGateway } from "../model-gateway";
import { NovelPostgresRepository } from "../postgres-repository";
import { ExternalMcpRequiredError, ModelRoutingConfigError, createRoutingSnapshot, resolveRoute, validateModelRoutingConfig, type ModelProviderProfile, type ModelRoutingConfig } from "../model-routing";

function profile(overrides: Partial<ModelProviderProfile> = {}): ModelProviderProfile {
  return {
    id: "primary",
    label: "Primary",
    protocol: "chat-completions",
    baseUrl: "https://example.test/v1",
    model: "writer-model",
    responseMode: "json",
    capabilities: ["text", "structured", "stream", "embedding", "rerank"],
    secret: { source: "inline", value: "toolkey-secret" },
    enabled: true,
    ...overrides,
  };
}

function config(profiles = [profile()], candidates: ModelRoutingConfig["routes"][string]["candidates"] = [{ executor: "api", profileId: "primary" }]): ModelRoutingConfig {
  return { version: 1, profiles, routes: { "*": { candidates, conversationPolicy: "stateless" } } };
}

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://ymcp:ymcp@127.0.0.1:5432/ymcp_test";

afterEach(() => vi.unstubAllGlobals());

describe("model routing config", () => {
  it("overrides only the embedding route profile base URL for the active runtime", () => {
    const next = config([
      profile({ id: "writer", capabilities: ["text"] }),
      profile({ id: "embedding", capabilities: ["embedding"], baseUrl: "http://embedding/v1" }),
    ]);
    next.routes["memory.embed"] = { candidates: [{ executor: "api", profileId: "embedding" }] };
    const overridden = applyRuntimeModelOverrides(next, { embeddingBaseUrl: "http://127.0.0.1:8081/v1/" });
    expect(overridden.profiles.find((item) => item.id === "embedding")?.baseUrl).toBe("http://127.0.0.1:8081/v1");
    expect(overridden.profiles.find((item) => item.id === "writer")?.baseUrl).toBe("https://example.test/v1");
    expect(next.profiles.find((item) => item.id === "embedding")?.baseUrl).toBe("http://embedding/v1");
  });

  it("supports a different model override for each vector purpose on one provider", async () => {
    const next = config(
      [profile({ id: "vectors", model: "default-model", capabilities: ["embedding", "rerank"] })],
      [{ executor: "external-mcp" }],
    );
    next.routes["memory.embed"] = { candidates: [{ executor: "api", profileId: "vectors", model: "embed-model" }] };
    next.routes["memory.rerank"] = { candidates: [{ executor: "api", profileId: "vectors", model: "rerank-model" }] };
    const requestedModels: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requestedModels.push(JSON.parse(String(init?.body)).model);
      return url.endsWith("/embeddings")
        ? new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 })
        : new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }), { status: 200 });
    }));
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));

    await gateway.embed({ purpose: "memory.embed", texts: ["文本"] });
    await gateway.rerank({ purpose: "memory.rerank", query: "查询", documents: ["文本"] });

    expect(requestedModels).toEqual(["embed-model", "rerank-model"]);
  });

  it("masks inline secrets and never includes them in the routing snapshot", () => {
    const store = new ModelConfigStore("unused", config());
    expect(store.getMaskedConfig().profiles[0]).toMatchObject({ hasSecret: true, secretHint: "***cret" });
    expect(JSON.stringify(createRoutingSnapshot(config()))).not.toContain("toolkey-secret");
  });

  it("reloads file changes before a long-lived worker gateway resolves the next route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ymcp-model-config-"));
    const path = join(dir, "model-providers.local.yaml");
    try {
      const initial = config([profile({ model: "old-model" })]);
      const updated = config([profile({ model: "new-model" })]);
      const apiStore = new ModelConfigStore(path, initial);
      await apiStore.save(initial);

      const workerStore = new ModelConfigStore(path);
      await workerStore.load();
      const gateway = new RoutedModelGateway(workerStore);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await apiStore.save(updated);

      const requestedModels: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        requestedModels.push(JSON.parse(String(init?.body)).model);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }));

      const result = await gateway.generateText({ purpose: "writing.draft", prompt: "p" });

      expect(result.text).toBe("ok");
      expect(requestedModels).toEqual(["new-model"]);
      expect(result.provenance.model).toBe("new-model");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects task-chain on non-writing purposes", () => {
    const invalid = config([profile({ protocol: "responses", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] })]);
    invalid.routes = { "review.*": { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "task-chain" }, "*": { candidates: [{ executor: "api", profileId: "primary" }] } };
    expect(() => validateModelRoutingConfig(invalid)).toThrow(ModelRoutingConfigError);
  });

  it("allows Foundation review to use a dedicated structured route", () => {
    const next = config([profile()]);
    next.routes["review.*"] = { candidates: [{ executor: "external-mcp" }], conversationPolicy: "stateless" };
    next.routes["review.foundation"] = { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "stateless" };
    expect(resolveRoute(next, "review.foundation")).toEqual(next.routes["review.foundation"]);
    expect(() => validateModelRoutingConfig(next)).not.toThrow();
  });
});

describe("model routing persistence", () => {
  let repository: NovelPostgresRepository;
  let postgresAvailable = false;

  beforeAll(async () => {
    try {
      repository = new NovelPostgresRepository(TEST_DB_URL);
      await repository.pool.query("SELECT 1");
      await repository.migrate();
      postgresAvailable = true;
    } catch (error) {
      console.warn("[model-routing.test] Postgres 不可用，跳过持久化测试: " + (error as Error).message);
    }
  }, 30000);

  afterAll(async () => {
    if (postgresAvailable && repository) await repository.close();
  });

  it("persists external MCP candidates as JSONB arrays", async () => {
    if (!postgresAvailable) return;
    const next = config([], [{ executor: "external-mcp" }]);
    const snapshot = createRoutingSnapshot(next);
    await repository.projectModelRoutingConfig(next, snapshot);
    const result = await repository.pool.query("SELECT candidates FROM model_routes WHERE task_class = $1", ["*"]);
    expect(result.rows[0].candidates).toEqual([{ executor: "external-mcp" }]);
  });

  it("serializes concurrent API and worker routing refreshes", async () => {
    if (!postgresAvailable) return;
    const next = config([profile()]);
    const snapshot = createRoutingSnapshot(next);
    await expect(Promise.all([
      repository.projectModelRoutingConfig(next, snapshot),
      repository.projectModelRoutingConfig(next, snapshot),
    ])).resolves.toHaveLength(2);
    const providers = await repository.pool.query("SELECT id FROM provider_configs WHERE config_revision=$1", [snapshot.id]);
    expect(providers.rows).toHaveLength(snapshot.profiles.length);
  });
});

describe("RoutedModelGateway adapters", () => {
  it("adds inferable primitive types for enum and const schema nodes at transport time", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "passed", enabled: true }) } }] }), { status: 200 });
    }));
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "enabled"],
      properties: { verdict: { enum: ["passed"] }, enabled: { const: true } },
    };
    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config())).generateStructured({ purpose: "review.arc", prompt: "输出审核结果", schema })).resolves.toMatchObject({ value: { verdict: "passed", enabled: true } });
    const sent = (requestBody?.response_format as Record<string, unknown>)?.json_schema as Record<string, unknown>;
    expect(sent.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "enabled"],
      properties: { verdict: { enum: ["passed"], type: "string" }, enabled: { const: true, type: "boolean" } },
    });
    expect(normalizeProviderJsonSchema(schema)).toEqual(sent.schema);
    expect(schema.properties.verdict).toEqual({ enum: ["passed"] });
  });

  it("aggregates one stateless Chat Completions SSE request", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "complete prompt" }]);
      expect(body.stream).toBe(true);
      const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"id":"r1","choices":[{"delta":{"content":"hello "}}]}\n\n')); controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n')); controller.close(); } });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new ModelConfigStore("unused", config([profile({ responseMode: "sse" })]));
    const result = await new RoutedModelGateway(store).generateText({ purpose: "writing.draft", system: "sys", prompt: "complete prompt" });
    expect(result.text).toBe("hello world");
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses previous_response_id only for a configured Responses writing chain", async () => {
    const responsesProfile = profile({ protocol: "responses", responseMode: "json", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] });
    const next = config([responsesProfile]);
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }] };
    next.routes["writing.*"] = { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "task-chain" };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ previous_response_id: "resp_previous", input: "revise" });
      return new Response(JSON.stringify({ id: "resp_next", output_text: "done", usage: { input_tokens: 12, output_tokens: 3 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new RoutedModelGateway(new ModelConfigStore("unused", next)).generateText({ purpose: "writing.revision", prompt: "revise", previousProfileId: "primary", previousResponseId: "resp_previous" });
    expect(result.provenance.responseId).toBe("resp_next");
  });

  it("moves to the next explicit candidate after a non-retryable provider error", async () => {
    const profiles = [profile({ id: "bad" }), profile({ id: "good", model: "good-model" })];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config(profiles, [{ executor: "api", profileId: "bad" }, { executor: "api", profileId: "good" }])));
    const result = await gateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(result.text).toBe("ok");
    expect(result.provenance).toMatchObject({ candidateIndex: 1, profileId: "good", model: "good-model" });
  });

  it("moves structured calls to the next API candidate after an exhausted empty response", async () => {
    const profiles = [profile({ id: "empty" }), profile({ id: "good", model: "good-model" })];
    const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config(profiles, [
      { executor: "api", profileId: "empty" },
      { executor: "external-mcp" },
      { executor: "api", profileId: "good" },
    ])));

    const result = await gateway.generateStructured<{ ok: boolean }>({
      purpose: "facts.extract",
      prompt: "extract",
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    });

    expect(result.value).toEqual({ ok: true });
    expect(result.provenance).toMatchObject({ candidateIndex: 2, profileId: "good", model: "good-model" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("counts the final prompt against the effective context budget and records the failure", async () => {
    const next = config([profile({ contextWindow: 64 })]);
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }], maxInputTokens: 40, maxOutputTokens: 16 };
    const promptRecorder = vi.fn(async () => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next), undefined, promptRecorder);

    await expect(gateway.generateStructured({ purpose: "review.reader", prompt: "正文".repeat(100), schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, maxTokens: 16 }))
      .rejects.toThrow("context-budget-exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(promptRecorder).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCategory: "context-budget-exceeded" }));
  });

  it("keeps the original task semantics while repairing invalid structured output", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requestBodies.length === 1
        ? JSON.stringify({ score: 4 })
        : JSON.stringify({ name: "保留克制对白", score: 4 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));

    const result = await gateway.generateStructured<{ name: string; score: number }>({
      purpose: "review.reader",
      system: "你是对白修订目标验收员。",
      prompt: "检查候选是否减少解释性对白，并保留人物之间的试探感。",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score"],
        properties: { name: { type: "string" }, score: { type: "number" } },
      },
      maxRepairAttempts: 1,
    });

    expect(result.value).toEqual({ name: "保留克制对白", score: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    expect(repairMessages.find((message) => message.role === "system")?.content).toContain("对白修订目标验收员");
    expect(repairMessages.find((message) => message.role === "user")?.content).toContain("减少解释性对白，并保留人物之间的试探感");
  });

  it("bounds invalid output carried into schema repair without dropping the original task", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const next = config();
    next.routes["*"] = { candidates: [{ executor: "api", profileId: "primary" }], maxInputTokens: 400, maxOutputTokens: 64 };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requestBodies.length === 1 ? `{"invalid":"${"冗余输出".repeat(500)}"}` : JSON.stringify({ ok: true });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));

    await expect(gateway.generateStructured<{ ok: boolean }>({
      purpose: "review.reader",
      prompt: "核对人物是否通过行动而非解释性对白表达戒备。",
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      maxTokens: 64,
      maxRepairAttempts: 1,
    })).resolves.toMatchObject({ value: { ok: true } });

    const repairMessages = requestBodies[1].messages as Array<{ role: string; content: string }>;
    const repairPrompt = repairMessages.find((message) => message.role === "user")?.content ?? "";
    expect(repairPrompt).toContain("核对人物是否通过行动而非解释性对白表达戒备");
    expect(repairPrompt).toContain("因上下文预算仅保留开头");
    expect(repairPrompt.length).toBeLessThan(800);
  });

  it("applies route context budgets before creating an external MCP task", async () => {
    const next = config([], [{ executor: "external-mcp" }]);
    next.routes["*"] = { candidates: [{ executor: "external-mcp" }], maxInputTokens: 10 };
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", next));
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "超长正文".repeat(20) }))
      .rejects.toThrow("context-budget-exceeded");
  });

  it("uses the SiliconFlow embedding contract and restores response index order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://example.test/v1/embeddings");
      expect(JSON.parse(String(init?.body))).toEqual({ model: "writer-model", input: ["甲", "乙"], encoding_format: "float" });
      return new Response(JSON.stringify({
        data: [
          { object: "embedding", index: 1, embedding: [0, 1] },
          { object: "embedding", index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RoutedModelGateway(new ModelConfigStore("unused", config())).embed({ purpose: "memory.embed", texts: ["甲", "乙"] });

    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
    expect(result.usage).toMatchObject({ inputTokens: 2, outputTokens: 0, usageSource: "provider" });
  });

  it("maps SiliconFlow sorted rerank results back to document order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://example.test/v1/rerank");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "writer-model",
        query: "人物关系",
        documents: ["天气", "旧友重逢", "城门"],
        top_n: 3,
        return_documents: false,
      });
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 2, relevance_score: 0.37 },
          { index: 0, relevance_score: 0.08 },
        ],
        meta: { tokens: { input_tokens: 12, output_tokens: 3 } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RoutedModelGateway(new ModelConfigStore("unused", config())).rerank({
      purpose: "memory.rerank",
      query: "人物关系",
      documents: ["天气", "旧友重逢", "城门"],
    });

    expect(result.scores).toEqual([0.08, 0.91, 0.37]);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, usageSource: "provider" });
  });

  it("rejects an incomplete rerank response instead of assigning silent zero scores", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.91 }],
      meta: { tokens: { input_tokens: 4, output_tokens: 1 } },
    }), { status: 200 })));

    await expect(new RoutedModelGateway(new ModelConfigStore("unused", config())).rerank({
      purpose: "memory.rerank",
      query: "关系",
      documents: ["天气", "旧友"],
    })).rejects.toThrow("要求覆盖 2 个文档");
  });

  it("marks an exhausted retryable transport failure as non-retryable for the workflow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("gateway unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));

    await expect(gateway.generateText({ purpose: "writing.revision", prompt: "revise" }))
      .rejects.toMatchObject({ name: "NonRetryableModelTransportError" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("also terminates structured review calls after their transport retries are exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("gateway unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config()));

    await expect(gateway.generateStructured({
      purpose: "review.reader",
      prompt: "review",
      schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } },
    })).rejects.toMatchObject({ name: "NonRetryableModelTransportError" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not call fetch for an external MCP route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config([], [{ executor: "external-mcp" }])));
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p" })).rejects.toBeInstanceOf(ExternalMcpRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
