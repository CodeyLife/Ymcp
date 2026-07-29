import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

  constructor(readonly path = process.env.NOVEL_MODEL_CONFIG_PATH ?? DEFAULT_MODEL_CONFIG_PATH, initial = createInitialModelConfig()) {
    validateModelRoutingConfig(initial);
    this.current = structuredClone(initial);
    this.snapshot = createRoutingSnapshot(this.current);
  }

  async load(): Promise<ModelRoutingConfig> {
    try {
      const parsed = parse(await readFile(this.path, "utf8")) as ModelRoutingConfig;
      validateModelRoutingConfig(parsed);
      this.current = structuredClone(parsed);
      this.snapshot = createRoutingSnapshot(this.current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return this.getConfig();
  }

  getConfig(): ModelRoutingConfig { return structuredClone(this.current); }
  getSnapshot(): ModelRoutingSnapshot { return structuredClone(this.snapshot); }

  getMaskedConfig() {
    return {
      version: this.current.version,
      profiles: this.current.profiles.map(({ secret, ...profile }) => ({ ...profile, ...maskSecret(secret) })),
      routes: structuredClone(this.current.routes),
      snapshotId: this.snapshot.id,
    };
  }

  getProfile(profileId: string): ModelProviderProfile | undefined {
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
    return this.getConfig();
  }
}
