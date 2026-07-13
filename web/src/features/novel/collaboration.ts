import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

export interface CollaborativeDocument {
  doc: Y.Doc;
  content: Y.XmlFragment;
  comments: Y.Array<Record<string, unknown>>;
  metadata: Y.Map<unknown>;
  persistence: IndexeddbPersistence;
  ready: Promise<void>;
  destroy: () => Promise<void>;
}

/**
 * Opens the durable Yjs document used by TipTap collaboration extensions.
 * A websocket provider can be attached to the returned Y.Doc without changing
 * editor storage or document identity.
 */
export function openCollaborativeDocument(projectId: string, documentId: string): CollaborativeDocument {
  const roomId = `ymcp-novel:${projectId}:${documentId}`;
  const doc = new Y.Doc({ guid: roomId });
  const persistence = new IndexeddbPersistence(roomId, doc);
  return {
    doc,
    content: doc.getXmlFragment("prosemirror"),
    comments: doc.getArray<Record<string, unknown>>("comments"),
    metadata: doc.getMap("metadata"),
    persistence,
    ready: persistence.whenSynced.then(() => undefined),
    destroy: async () => {
      persistence.destroy();
      doc.destroy();
    },
  };
}

export async function deleteCollaborativeDocument(projectId: string, documentId: string) {
  const collaboration = openCollaborativeDocument(projectId, documentId);
  await collaboration.ready;
  await collaboration.persistence.clearData();
  collaboration.doc.destroy();
}
