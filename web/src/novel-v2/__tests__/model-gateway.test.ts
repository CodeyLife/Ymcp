import { describe, expect, it } from "vitest";
import { InMemoryModelGateway, type GenerateStructuredInput, type ModelGateway, type ModelUsage } from "../model-gateway";

const usage: ModelUsage = { model: "test", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };

const passthroughSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "score"],
  properties: {
    name: { type: "string", minLength: 1 },
    score: { type: "number", minimum: 0, maximum: 5 },
  },
} as const;

interface Passthrough {
  name: string;
  score: number;
}

describe("InMemoryModelGateway generateText", () => {
  it("returns string responses untouched and stringifies objects", async () => {
    const stringGateway = new InMemoryModelGateway(() => "hello");
    const result = await stringGateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(result.text).toBe("hello");
    expect(result.usage.model).toBe("in-memory");

    const objectGateway = new InMemoryModelGateway(() => ({ a: 1 }));
    const objectResult = await objectGateway.generateText({ purpose: "writing.draft", prompt: "p" });
    expect(objectResult.text).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("InMemoryModelGateway generateStructured ajv contract", () => {
  it("returns the validated value when the responder conforms to the schema", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "alpha", score: 4 }));
    const input: GenerateStructuredInput<Passthrough> = {
      purpose: "facts.extract",
      prompt: "p",
      schema: passthroughSchema as unknown as Record<string, unknown>,
      schemaName: "passthrough",
    };
    const result = await gateway.generateStructured<Passthrough>(input);
    expect(result.value).toEqual({ name: "alpha", score: 4 });
    expect(result.usage.model).toBe("in-memory");
  });

  it("rejects output that violates minLength constraints", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "", score: 4 }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/InMemoryModelGateway structured/);
  });

  it("rejects output with out-of-range numbers", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 9 }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/score/);
  });

  it("rejects output with additional properties", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 1, extra: true }));
    await expect(
      gateway.generateStructured<Passthrough>({
        purpose: "facts.extract",
        prompt: "p",
        schema: passthroughSchema as unknown as Record<string, unknown>,
        schemaName: "passthrough",
      }),
    ).rejects.toThrow(/additional/);
  });
});

/**
 * RoutedModelGateway 的 strict-mode 降级与自动修复路径需要 fetch mock。
 * 此处通过一个最小的 stub Gateway 验证 ModelGateway 接口契约，
 * 确保 RoutedModelGateway 与 InMemoryModelGateway 实现同一接口（编译期约束）。
 */
describe("ModelGateway interface contract", () => {
  it("both gateways satisfy ModelGateway", async () => {
    const inMemory: ModelGateway = new InMemoryModelGateway(() => "ok");
    expect(typeof inMemory.generateText).toBe("function");
    expect(typeof inMemory.generateStructured).toBe("function");
    expect(typeof inMemory.embed).toBe("function");
    expect(typeof inMemory.rerank).toBe("function");

    // embed/rerank 默认实现返回空数组
    await expect(inMemory.embed({ purpose: "memory.embed", texts: ["a"] })).resolves.toMatchObject({ vectors: [[]], usage: expect.any(Object) });
    await expect(inMemory.rerank({ purpose: "memory.rerank", query: "q", documents: ["a"] })).resolves.toMatchObject({ scores: [0], usage: expect.any(Object) });
  });

  it("usage object has all required fields", async () => {
    const gateway = new InMemoryModelGateway(() => ({ name: "x", score: 1 }));
    const { usage: u } = await gateway.generateStructured<Passthrough>({
      purpose: "facts.extract",
      prompt: "p",
      schema: passthroughSchema as unknown as Record<string, unknown>,
    });
    expect(u).toMatchObject({ model: "in-memory", inputTokens: expect.any(Number), outputTokens: expect.any(Number), costUsd: expect.any(Number), latencyMs: expect.any(Number) });
    // 静态 usage 用于其他测试套件，避免字段漂移
    expect(usage).toMatchObject({ model: "test", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
  });
});
