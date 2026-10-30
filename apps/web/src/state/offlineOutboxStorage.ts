import type { OfflineMessage } from "./offlineOutbox";

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("t3code:offline-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("messages");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const transaction = (await openDatabase()).transaction("messages", mode);
  const request = operation(transaction.objectStore("messages"));
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Could not save offline messages."));
    transaction.onerror = () => reject(transaction.error);
  });
}
export const offlineOutboxStorage = {
  load: async (): Promise<OfflineMessage[]> => {
    const messages: OfflineMessage[] = await transact("readonly", (store) => store.getAll());
    return messages.sort((a, b) =>
      (a.input.createdAt ?? "").localeCompare(b.input.createdAt ?? ""),
    );
  },
  put: async (message: OfflineMessage) => {
    await transact("readwrite", (store) => store.put(message, message.input.message.messageId));
  },
  remove: async (id: string) => {
    await transact("readwrite", (store) => store.delete(id));
  },
};
