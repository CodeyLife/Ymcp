import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfigStore } from "../model-config-store";
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

  it("does not call fetch for an external MCP route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new RoutedModelGateway(new ModelConfigStore("unused", config([], [{ executor: "external-mcp" }])));
    await expect(gateway.generateText({ purpose: "writing.draft", prompt: "p" })).rejects.toBeInstanceOf(ExternalMcpRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
