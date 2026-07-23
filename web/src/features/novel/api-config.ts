import { DEFAULT_API_KEY, DEFAULT_BASE_URL } from "@/config/defaults";
import { getEffectiveApiConfig } from "@/stores/ui";

export interface NovelApiConfig {
  baseUrl: string;
  apiKey: string;
  modelContextWindow: number;
}

let provider: (() => NovelApiConfig) | undefined;

export function setNovelApiConfigProvider(next?: () => NovelApiConfig) {
  provider = next;
}

export function getNovelApiConfig(): NovelApiConfig {
  if (provider) return provider();
  try {
    const config = getEffectiveApiConfig();
    return { baseUrl: config.baseUrl, apiKey: config.apiKey, modelContextWindow: config.modelContextWindow };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, apiKey: DEFAULT_API_KEY, modelContextWindow: 0 };
  }
}
