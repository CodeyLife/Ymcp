import type { ChangeOperation, SyncConflict } from "./types";
import { novelDb } from "./db";

export interface SyncBatch {
  projectId: string;
  cursor?: string;
  operations: ChangeOperation[];
}

export interface SyncResult {
  cursor: string;
  acceptedOperationIds: string[];
  remoteOperations: ChangeOperation[];
  conflicts: SyncConflict[];
}

export interface NovelSyncAdapter {
  pushPull(batch: SyncBatch, signal?: AbortSignal): Promise<SyncResult>;
  subscribe(projectId: string, onOperation: (operation: ChangeOperation) => void): () => void;
}

export class HttpNovelSyncAdapter implements NovelSyncAdapter {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async pushPull(batch: SyncBatch, signal?: AbortSignal): Promise<SyncResult> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/projects/${batch.projectId}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(batch),
      signal,
    });
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || `同步失败 HTTP ${response.status}`);
    return response.json() as Promise<SyncResult>;
  }

  subscribe(projectId: string, onOperation: (operation: ChangeOperation) => void) {
    const url = new URL(this.baseUrl.replace(/^http/, "ws"));
    url.pathname = `${url.pathname.replace(/\/$/, "")}/projects/${projectId}/events`;
    url.searchParams.set("token", this.token);
    const socket = new WebSocket(url);
    socket.onmessage = (event) => onOperation(JSON.parse(event.data) as ChangeOperation);
    return () => socket.close();
  }
}

export async function syncProject(projectId: string, adapter: NovelSyncAdapter, cursor?: string) {
  const operations = await novelDb.operations.where({ projectId, syncStatus: "local" }).toArray();
  const result = await adapter.pushPull({ projectId, cursor, operations });
  await novelDb.transaction("rw", novelDb.operations, novelDb.conflicts, async () => {
    await novelDb.operations.where("operationId").anyOf(result.acceptedOperationIds).modify({ syncStatus: "synced" });
    await novelDb.conflicts.bulkPut(result.conflicts);
  });
  return result;
}

