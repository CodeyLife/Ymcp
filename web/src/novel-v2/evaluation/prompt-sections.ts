const ALLOWED_PROMPT_STAGES = new Set([
  "foundation",
  "planning",
  "drafting",
  "review",
  "revision",
  "fact-extraction",
]);

export function validatePromptSections(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 prompt_sections 对象`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([stage, text]) => !ALLOWED_PROMPT_STAGES.has(stage) || typeof text !== "string" || !text.trim())) {
    throw new Error(`${label} 包含非法阶段或空 prompt`);
  }
  return Object.fromEntries(entries.map(([stage, text]) => [stage, (text as string).trim()]));
}

export function parseSerializedPromptSections(value: string, label: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} 必须是 JSON prompt_sections 对象`);
  }
  return validatePromptSections(parsed, label);
}

export function serializePromptSections(value: unknown, label: string): string {
  return JSON.stringify(validatePromptSections(value, label));
}
