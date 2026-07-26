const NOVEL_BUILD_ENV = import.meta.env as Record<string, unknown>;

export function readNovelBuildEnv(name: string): string | undefined {
  const value = NOVEL_BUILD_ENV[`VITE_${name}`] ?? NOVEL_BUILD_ENV[name];
  return typeof value === "string" ? value : undefined;
}
