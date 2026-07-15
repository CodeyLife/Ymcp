import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

const databases = ["ymcp-image-db", "ymcp-model-db"];

function openDatabaseWithoutExpectedStore(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("legacy");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

afterEach(async () => {
  await Promise.all(databases.map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
});

describe("browser cache stores", () => {
  it("repairs an existing image database that is missing the images store", async () => {
    await openDatabaseWithoutExpectedStore("ymcp-image-db");
    const { getImage } = await import("../imageStore");

    await expect(getImage("missing-image")).resolves.toBeUndefined();
  });

  it("repairs an existing model database that is missing the models store", async () => {
    await openDatabaseWithoutExpectedStore("ymcp-model-db");
    const { getCachedModelSize } = await import("../modelStore");

    await expect(getCachedModelSize()).resolves.toBeNull();
  });
});
