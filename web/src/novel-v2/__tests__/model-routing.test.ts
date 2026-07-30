import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfigStore, applyRuntimeModelOverrides } from "../model-config-store";
import { RoutedModelGateway } from "../model-gateway";
import { NovelPostgresRepository } from "../postgres-repository";
import { ExternalMcpRequiredError, ModelRoutingConfigError, createRoutingSnapshot, validateModelRoutingConfig, type ModelProviderProfile, type ModelRoutingConfig } from "../model-routing";

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

  it("rejects task-chain on non-writing purposes", () => {
    const invalid = config([profile({ protocol: "responses", capabilities: ["text", "structured", "responses-continuation", "embedding", "rerank"] })]);
    invalid.routes = { "review.*": { candidates: [{ executor: "api", profileId: "primary" }], conversationPolicy: "task-chain" }, "*": { candidates: [{ executor: "api", profileId: "primary" }] } };
    expect(() => validateModelRoutingConfig(invalid)).toThrow(ModelRoutingConfigError);
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
});

describe("RoutedModelGateway adapters", () => {
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
