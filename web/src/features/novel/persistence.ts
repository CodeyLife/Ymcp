export type ManuscriptSaveState = "saved" | "dirty" | "saving" | "error";

export function createManuscriptPersistenceGuard() {
  let editVersion = 0;
  return {
    markEdited() {
      editVersion += 1;
    },
    beginSave() {
      return editVersion;
    },
    isSaveCurrent(saveVersion: number) {
      return saveVersion === editVersion;
    },
    reset() {
      editVersion = 0;
    },
  };
}

export function shouldApplyStoredManuscriptContent(params: {
  saveState: ManuscriptSaveState;
  editorHtml: string;
  storedContentHtml: string;
}) {
  return params.saveState === "saved" && params.editorHtml !== params.storedContentHtml;
}

export async function requestDurableBrowserStorage() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const persisted = await navigator.storage.persisted?.();
  if (persisted) return { supported: true, persisted: true };
  return { supported: true, persisted: await navigator.storage.persist() };
}
