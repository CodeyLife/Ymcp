import { describe, expect, it } from "vitest";
import { isTransientPostgresStartupError } from "../postgres-repository";

describe("postgres repository startup errors", () => {
  it("retries Postgres startup and recovery errors", () => {
    expect(isTransientPostgresStartupError({ code: "57P03", message: "the database system is not yet accepting connections" })).toBe(true);
    expect(isTransientPostgresStartupError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" })).toBe(true);
    expect(isTransientPostgresStartupError({ message: "Consistent recovery state has not been yet reached." })).toBe(true);
  });

  it("does not retry configuration or migration errors", () => {
    expect(isTransientPostgresStartupError({ code: "28P01", message: "password authentication failed for user ymcp" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "3D000", message: "database ymcp does not exist" })).toBe(false);
    expect(isTransientPostgresStartupError({ code: "42601", message: "syntax error at or near SELECT" })).toBe(false);
  });
});
