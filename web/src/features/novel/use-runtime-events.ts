import { useEffect } from "react";
import { queryClient } from "@/lib/queryClient";
import { novelRuntimeClient } from "./runtime-client";
import { refreshRuntimeProjection, refreshRuntimeProjectListProjection } from "./runtime-records";

const PROJECTION_EVENTS = new Set([
  "change.accepted",
  "project.records-mutated",
  "project.chapter-deleted",
]);

export function useNovelRuntimeEvents(projectId?: string) {
  useEffect(() => {
    const events = new EventSource(novelRuntimeClient.eventsUrl(projectId));
    let projectionSync = Promise.resolve();
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type?: string; projectId?: string };
      if (payload.projectId && PROJECTION_EVENTS.has(String(payload.type))) {
        projectionSync = projectionSync
          .then(async () => { await refreshRuntimeProjection(payload.projectId!); })
          .catch(() => undefined);
      } else if (!projectId && payload.type === "project.created") {
        projectionSync = projectionSync
          .then(async () => { await refreshRuntimeProjectListProjection(); })
          .catch(() => undefined);
      }
      void projectionSync.finally(() => queryClient.invalidateQueries({ queryKey: ["novel-runtime"] }));
    };
    return () => events.close();
  }, [projectId]);
}
