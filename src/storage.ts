/**
 * File storage: ctx.storage in routes, sockets and jobs, app.storage everywhere else.
 *
 *   const app = createApp({ routes, storage: diskStorage({ dir: "./uploads" }) });
 *
 *   const saved = await storage.put(`avatars/${user.id}.png`, body.avatar); // a File from t.file(), a Blob, bytes or text
 *   const file = await storage.get(`avatars/${user.id}.png`);               // a web File, or null
 *   await storage.delete(`avatars/${user.id}.png`);                         // true when it existed
 *
 * The store is chosen once in createApp({ storage }): memoryStorage() (one process, tests), diskStorage({ dir })
 * (a local or mounted directory), or any object that implements StorageStore.
 */
import { InferloError } from "./errors.ts";

/** What storage.put() stored. */
export interface StoredFile {
  key: string;
  /** Size in bytes. */
  size: number;
  /** Media type, for example "image/png". */
  type: string;
}

/** Where files are kept. Implement it to use another store; Inferlo checks keys and types before calling it. */
export interface StorageStore {
  /** Shown in describe() and as app.storage.store, for example "memory" or "disk". */
  readonly name: string;
  /** Store the bytes and their media type under the key, replacing what was there. */
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  /** The bytes and media type stored under the key, or null. */
  get(key: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  /** Remove the key. Resolves to true when it existed. */
  delete(key: string): Promise<boolean>;
}

export interface StoragePutOptions {
  /** Media type to store. Default: the File's or Blob's type, or "application/octet-stream". */
  type?: string;
}

export interface Storage {
  /** The store's name ("memory", "disk", ...), or null when createApp has no storage option. */
  readonly store: string | null;
  /**
   * Store a file under a key such as "avatars/42.png" (segments of letters, digits, ".", "_" and "-", separated by "/"),
   * replacing what was there. Keys are the same for every user and tenant: put the tenant or user id in the key.
   */
  put(key: string, data: Blob | Uint8Array | ArrayBuffer | string, options?: StoragePutOptions): Promise<StoredFile>;
  /** The file stored under the key as a web File (name: the key's last segment), or null when there is none. */
  get(key: string): Promise<File | null>;
  /** Remove the file. Resolves to true when it existed. */
  delete(key: string): Promise<boolean>;
}

const MAX_KEY_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const DEFAULT_TYPE = "application/octet-stream";

function invalidKey(key: unknown, why: string): InferloError {
  return new InferloError("IL6039", `Invalid storage key ${JSON.stringify(key)}: ${why}.`, {
    fix: 'Use keys made of segments of letters, digits, ".", "_" and "-" (not starting with "."), separated by "/", for example `avatars/${user.id}.png`. Never use a file name sent by the client as the key.',
  });
}

/** Throws IL6039 unless the key is safe for every store (no "..", no leading "/", no hidden files). */
export function checkStorageKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) throw invalidKey(key, "keys are non-empty strings");
  if (key.length > MAX_KEY_LENGTH) throw invalidKey(key.slice(0, 40) + "...", `keys are at most ${MAX_KEY_LENGTH} characters`);
  for (const segment of key.split("/")) {
    if (!SEGMENT.test(segment)) throw invalidKey(key, segment === "" ? 'empty segment (a leading, trailing or double "/")' : `segment "${segment}" is not allowed`);
  }
  return key;
}

function checkType(type: string): string {
  const lower = type.toLowerCase();
  if (!MEDIA_TYPE.test(lower)) {
    throw new InferloError("IL6039", `Invalid media type ${JSON.stringify(type)} for storage.put().`, {
      fix: 'Pass a plain media type without parameters, for example { type: "image/png" } or "application/pdf".',
    });
  }
  return lower;
}

async function toBytes(data: Blob | Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new InferloError("IL6039", "storage.put() takes a File, Blob, Uint8Array, ArrayBuffer or string.", {
    fix: "Pass the File from a t.file() field directly: await storage.put(key, body.avatar).",
  });
}

function blobType(data: unknown): string {
  return typeof Blob !== "undefined" && data instanceof Blob && data.type ? data.type.split(";")[0]!.trim() : "";
}

/** Throws IL6038 unless the value implements StorageStore. */
export function checkStorageStore(value: unknown): StorageStore | undefined {
  if (value === undefined) return undefined;
  const store = value as Partial<StorageStore> | null;
  if (!store || typeof store !== "object" || typeof store.name !== "string" || !store.name || typeof store.put !== "function" || typeof store.get !== "function" || typeof store.delete !== "function") {
    throw new InferloError("IL6038", "Invalid storage option in createApp.", {
      fix: 'Pass a store: createApp({ storage: diskStorage({ dir: "./uploads" }) }), memoryStorage() in tests, or an object with name, put(key, bytes, type), get(key) and delete(key).',
    });
  }
  return store as StorageStore;
}

/** The ctx.storage and app.storage API on top of a store (or one that throws IL6037 when there is none). */
export function createStorage(store: StorageStore | undefined): Storage {
  const need = (): StorageStore => {
    if (store) return store;
    throw new InferloError("IL6037", "ctx.storage was used, but createApp has no storage option.", {
      fix: 'Choose where files are kept: createApp({ storage: diskStorage({ dir: "./uploads" }) }), or memoryStorage() in tests.',
    });
  };
  return {
    store: store?.name ?? null,
    async put(key, data, options = {}) {
      const s = need();
      checkStorageKey(key);
      const type = checkType(options.type ?? (blobType(data) || DEFAULT_TYPE));
      const bytes = await toBytes(data);
      await s.put(key, bytes, type);
      return { key, size: bytes.byteLength, type };
    },
    async get(key) {
      const s = need();
      checkStorageKey(key);
      const found = await s.get(key);
      if (!found) return null;
      return new File([found.bytes as Uint8Array<ArrayBuffer>], key.slice(key.lastIndexOf("/") + 1), { type: found.type || DEFAULT_TYPE });
    },
    async delete(key) {
      const s = need();
      checkStorageKey(key);
      return s.delete(key);
    },
  };
}

/** Files kept in this process's memory: for tests and single-process development. Lost on restart. */
export function memoryStorage(): StorageStore {
  const files = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    name: "memory",
    async put(key, bytes, type) {
      files.set(key, { bytes: bytes.slice(), type });
    },
    async get(key) {
      const found = files.get(key);
      return found ? { bytes: found.bytes.slice(), type: found.type } : null;
    },
    async delete(key) {
      return files.delete(key);
    },
  };
}
