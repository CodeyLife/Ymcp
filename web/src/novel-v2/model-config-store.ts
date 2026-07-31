import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  createRoutingSnapshot,
  maskSecret,
  type ModelProviderProfile,
  type ModelRoutingConfig,
  type ModelRoutingSnapshot,
  validateModelRoutingConfig,
} from "./model-routing";

export const DEFAULT_MODEL_CONFIG_PATH = join(process.cwd(), "config", "model-providers.local.yaml");

export function applyRuntimeModelOverrides(
  config: ModelRoutingConfig,
  overrides: { embeddingBaseUrl?: string } = {},
): ModelRoutingConfig {
  const embeddingBaseUrl = overrides.embeddingBaseUrl?.trim().replace(/\/+$/, "");
  if (!embeddingBaseUrl) return structuredClone(config);
  const embeddingProfileIds = new Set(
    (config.routes["memory.embed"]?.candidates ?? [])
      .filter((candidate) => candidate.executor === "api")
      .map((candidate) => candidate.profileId),
  );
  return {
    ...structuredClone(config),
    profiles: config.profiles.map((profile) => embeddingProfileIds.has(profile.id) && profile.capabilities.includes("embedding")
      ? { ...structuredClone(profile), baseUrl: embeddingBaseUrl }
      : structuredClone(profile)),
  };
}

export function createInitialModelConfig(): ModelRoutingConfig {
  return {
    version: 1,
    profiles: [],
    routes: { "*": { conversationPolicy: "stateless", candidates: [{ executor: "external-mcp" }] } },
  };
}

export class ModelConfigStore {
  private current: ModelRoutingConfig;
  private snapshot: ModelRoutingSnapshot;
  private loadedMtimeMs?: number;

  constructor(readonly path = process.env.NOVEL_MODEL_CONFIG_PATH ?? DEFAULT_MODEL_CONFIG_PATH, initial = createInitialModelConfig()) {
    validateModelRoutingConfig(initial);
    this.current = structuredClone(initial);
    this.snapshot = createRoutingSnapshot(this.current);
  }

  async load(): Promise<ModelRoutingConfig> {
    try {
      const parsed = parse(await readFile(this.path, "utf8")) as ModelRoutingConfig;
      validateModelRoutingConfig(parsed);
      this.current = applyRuntimeModelOverrides(parsed, { embeddingBaseUrl: process.env.NOVEL_EMBEDDING_BASE_URL });
      this.snapshot = createRoutingSnapshot(this.current);
      this.loadedMtimeMs = (await stat(this.path).catch(() => undefined))?.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return this.getConfig();
  }

  private reloadIfChanged(): void {
    try {
      const stats = statSync(this.path);
      if (this.loadedMtimeMs !== undefined && stats.mtimeMs <= this.loadedMtimeMs) return;
      const parsed = parse(readFileSync(this.path, "utf8")) as ModelRoutingConfig;
      validateModelRoutingConfig(parsed);
      this.current = applyRuntimeModelOverrides(parsed, { embeddingBaseUrl: process.env.NOVEL_EMBEDDING_BASE_URL });
      this.snapshot = createRoutingSnapshot(this.current);
      this.loadedMtimeMs = stats.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
  }

  getConfig(): ModelRoutingConfig { this.reloadIfChanged(); return structuredClone(this.current); }
  getSnapshot(): ModelRoutingSnapshot { this.reloadIfChanged(); return structuredClone(this.snapshot); }

  getMaskedConfig() {
    this.reloadIfChanged();
    return {
      version: this.current.version,
      profiles: this.current.profiles.map(({ secret, ...profile }) => ({ ...profile, ...maskSecret(secret) })),
      routes: structuredClone(this.current.routes),
      snapshotId: this.snapshot.id,
    };
  }

  getProfile(profileId: string): ModelProviderProfile | undefined {
    this.reloadIfChanged();
    const profile = this.current.profiles.find((item) => item.id === profileId);
    return profile ? structuredClone(profile) : undefined;
  }

  async save(next: ModelRoutingConfig): Promise<ModelRoutingConfig> {
    validateModelRoutingConfig(next);
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tempPath, stringify(next), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.path);
    this.current = structuredClone(next);
    this.snapshot = createRoutingSnapshot(this.current);
    this.loadedMtimeMs = (await stat(this.path).catch(() => undefined))?.mtimeMs;
    return this.getConfig();
  }
}
