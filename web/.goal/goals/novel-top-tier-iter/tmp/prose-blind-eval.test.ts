import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_API_KEY } from "@/config/defaults";

vi.mock("@/stores/ui", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEffectiveApiConfig: () => ({
      baseUrl: "https://gpt.eromaa.com:443/v1",
      apiKey: DEFAULT_API_KEY,
      usesDefaultBaseUrl: false,
      hasOwnKey: true,
      modelContextWindow: 0,
    }),
  };
});

import { callStructuredNovelModel } from "@/features/novel/ai";

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence", "rationale"],
  properties: {
    verdict: { enum: ["below", "near", "same"] },
    evidence: { type: "string" },
    rationale: { type: "string" },
  },
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["evaluations", "sharedStrengths", "sharedGaps", "overallVerdict"],
  properties: {
    evaluations: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sample", "dimensions", "nearOrSameCount"],
        properties: {
          sample: { enum: ["A", "B"] },
          dimensions: {
            type: "object",
            additionalProperties: false,
            required: ["sentenceRhythm", "registerControl", "objectImagery", "characterVoices", "emotionalRestraint", "endingHook", "scenePresence"],
            properties: {
              sentenceRhythm: verdictSchema,
              registerControl: verdictSchema,
              objectImagery: verdictSchema,
              characterVoices: verdictSchema,
              emotionalRestraint: verdictSchema,
              endingHook: verdictSchema,
              scenePresence: verdictSchema,
            },
          },
          nearOrSameCount: { type: "integer", minimum: 0, maximum: 7 },
        },
      },
    },
    sharedStrengths: { type: "array", items: { type: "string" } },
    sharedGaps: { type: "array", items: { type: "string" } },
    overallVerdict: { enum: ["below", "near", "same"] },
  },
} as const;

describe("anonymous prose parity evaluation", () => {
  it("compares two current chapters against top-tier Chinese web-fiction technique standards", async () => {
    const root = process.cwd();
    const sampleA = readFileSync(join(root, ".novel-bench/runs/20260717-021322-draft/output.md"), "utf-8");
    const sampleB = readFileSync(join(root, ".novel-bench/runs/20260717-031327-draft/output.md"), "utf-8");

    const result = await callStructuredNovelModel<Record<string, unknown>>({
      model: "gpt-5-5",
      temperature: 0.1,
      role: "quality-editor",
      maxTokens: 8192,
      schema,
      prompt: `你是独立中文长篇小说总编。下面两篇匿名样本 A/B 的来源未知；不要猜测作者或生成方式，也不要读取任何既有评分。以《雪中悍刀行》《剑来》《庆余年》《我在风花雪月里等你》等成熟中文网文在对应技法上的已出版水准作为参照，只比较技法成熟度，不模仿、不引用参考作品原句。

逐篇检查七个维度：句式节奏、语体层次、器物与意象功能、群像声音区分、去情绪化与留白、章尾钩子、场景在场感。每个维度必须引用样本中的具体短句或段落现象作为 evidence；near 表示已接近成熟作品常规章节水平但仍有清晰差距，same 表示该维度可与成熟作品常规章节同级，below 表示存在持续性差距。不要因结构完整或语言古雅自动给 near，也不要因局部瑕疵否定整篇。nearOrSameCount 必须与七项 verdict 的实际数量一致。

样本 A：
${sampleA}

样本 B：
${sampleB}`,
    });

    const outputPath = join(root, ".goal/goals/novel-top-tier-iter/tmp/prose-blind-eval.json");
    writeFileSync(outputPath, JSON.stringify(result.data, null, 2));
    const evaluations = result.data.evaluations as Array<{ sample: string; nearOrSameCount: number }>;
    expect(evaluations).toHaveLength(2);
    expect(evaluations.map((item) => item.sample).sort()).toEqual(["A", "B"]);
  });
});
