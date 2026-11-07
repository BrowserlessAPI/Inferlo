/**
 * diskStorage({ dir }): files in a local or mounted directory (Node.js, Bun and Deno).
 *
 * Each file is written to a temporary file and renamed into place, so readers never see half a file. Its media type
 * is kept next to it in dir/.inferlo-meta/. Keys never start a segment with ".", so they cannot reach those files.
 * node:fs is loaded on first use, so importing Inferlo stays free of Node-only modules.
 */
import { InferloError } from "./errors.ts";
import { checkStorageKey, type StorageStore } from "./storage.ts";

export interface DiskStorageOptions {
  /** The directory files are kept in (created on first write). Relative paths start at the working directory. */
  dir: string;
}

const META_DIR = ".inferlo-meta";
const TMP_DIR = ".inferlo-tmp";

type Fs = typeof import("node:fs/promises");
type Path = typeof import("node:path");

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

export function diskStorage(options: DiskStorageOptions): StorageStore {
  if (!options || typeof options.dir !== "string" || options.dir.trim() === "") {
    throw new InferloError("IL6038", "diskStorage() needs a dir.", { fix: 'Pass the directory to keep files in: diskStorage({ dir: "./uploads" }), or env("UPLOADS_DIR") in production.' });
  }
  let loaded: Promise<{ fs: Fs; path: Path; root: string }> | undefined;
  const load = () =>
    (loaded ??= Promise.all([import("node:fs/promises"), import("node:path")]).then(([fs, path]) => ({ fs, path, root: path.resolve(options.dir) })));

  /** The file's path, checked to stay inside the directory. */
  const resolve = async (base: string, key: string) => {
    const { path, root } = await load();
    checkStorageKey(key);
    const top = path.join(root, base);
    const full = path.resolve(top, ...key.split("/"));
    if (!full.startsWith(top + path.sep)) throw new InferloError("IL6039", `Invalid storage key ${JSON.stringify(key)}: it leaves the storage directory.`);
    return full;
  };

  const writeAtomic = async (target: string, data: Uint8Array | string) => {
    const { fs, path, root } = await load();
    const tmpDir = path.join(root, TMP_DIR);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, crypto.randomUUID());
    try {
      await fs.writeFile(tmp, data);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  };

  return {
    name: "disk",
    async put(key, bytes, type) {
      const file = await resolve("", key);
      // The type first: a reader that sees the new bytes also sees their type.
      await writeAtomic(await resolve(META_DIR, key), type);
      await writeAtomic(file, bytes);
    },
    async get(key) {
      const { fs } = await load();
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fs.readFile(await resolve("", key)));
      } catch (error) {
        // A directory under the key (other keys below it) is not a file either.
        if (isMissing(error) || (error as { code?: string }).code === "EISDIR") return null;
        throw error;
      }
      let type = "application/octet-stream";
      try {
        type = (await fs.readFile(await resolve(META_DIR, key), "utf8")).trim() || type;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return { bytes, type };
    },
    async delete(key) {
      const { fs } = await load();
      const file = await resolve("", key);
      let existed = true;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) return false;
        await fs.rm(file);
      } catch (error) {
        if (!isMissing(error)) throw error;
        existed = false;
      }
      await fs.rm(await resolve(META_DIR, key), { force: true });
      return existed;
    },
  };
}
