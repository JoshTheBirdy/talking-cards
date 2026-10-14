// Per-device storage for engine files, voices and cached audio. IndexedDB, so nothing here
// syncs between devices or lands in the vault.

const DB_NAME = "talking-cards";
const DB_VERSION = 1;
export type StoreName = "files" | "voices" | "audio" | "audioMeta";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of ["files", "voices", "audio", "audioMeta"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed to open"));
  });
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB error"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: string) => run<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (store: StoreName, key: string, value: unknown) => run(store, "readwrite", (s) => s.put(value, key)),
  del: (store: StoreName, key: string) => run(store, "readwrite", (s) => s.delete(key)),
  keys: (store: StoreName) => run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys()).then((k) => k.map(String)),
  all: <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>),
  clear: (store: StoreName) => run(store, "readwrite", (s) => s.clear()),
};

export type Progress = (loaded: number, total: number) => void;

/**
 * Downloads with progress. Throws on HTTP errors or when the size doesn't match.
 * XMLHttpRequest, not requestUrl: voice models are tens of MB and need progress and cancelling,
 * which requestUrl doesn't offer. Every URL is a fixed Hugging Face / jsDelivr file (README: Network use).
 */
export function download(url: string, expectedSize?: number, onProgress?: Progress, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onprogress = (e) => onProgress?.(e.loaded, expectedSize ?? (e.lengthComputable ? e.total : 0));
    xhr.onerror = () => reject(new Error(`Download failed (network): ${url}`));
    xhr.onabort = () => reject(new DOMException("Download cancelled", "AbortError"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`Download failed (${xhr.status}): ${url}`));
      const buf = xhr.response as ArrayBuffer;
      if (expectedSize && buf.byteLength !== expectedSize) return reject(new Error(`Download was ${buf.byteLength} bytes, expected ${expectedSize}: ${url}`));
      resolve(buf);
    };
    if (signal?.aborted) return xhr.abort();
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send();
  });
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 64-bit FNV-1a, hex. For audio cache keys, not security. */
export function hashKey(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
