import type { UseStore } from "idb-keyval";

function openDatabase(dbName: string, storeName: string, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

async function openDatabaseWithStore(dbName: string, storeName: string): Promise<IDBDatabase> {
  const database = await openDatabase(dbName, storeName);
  if (database.objectStoreNames.contains(storeName)) return database;

  const repairVersion = database.version + 1;
  database.close();
  try {
    return await openDatabase(dbName, storeName, repairVersion);
  } catch (error) {
    if (error instanceof DOMException && error.name === "VersionError") return openDatabaseWithStore(dbName, storeName);
    throw error;
  }
}

export function createRepairingStore(dbName: string, storeName: string): UseStore {
  return async (txMode, callback) => {
    const database = await openDatabaseWithStore(dbName, storeName);
    try {
      const transaction = database.transaction(storeName, txMode);
      return await callback(transaction.objectStore(storeName));
    } finally {
      database.close();
    }
  };
}
