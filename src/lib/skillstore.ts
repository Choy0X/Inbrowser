import type { SkillResource } from "./skills";
import { isSafeResourcePath } from "./skills";

const DB_NAME = "fachoy-skill-resources";
const DB_VERSION = 1;
const STORE = "resources";

interface StoredResource {
  skillId: string;
  path: string;
  kind: SkillResource["kind"];
  /** Text content for text resources. */
  text?: string;
  /** Data URL for image/binary resources. */
  dataUrl?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["skillId", "path"] });
        store.createIndex("skillId", "skillId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open skill resource store"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => {
      resolve(req.result);
      tx.oncomplete = () => db.close();
    };
    req.onerror = () => {
      reject(req.error ?? new Error("Skill resource store error"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Persist the bundled resources for a skill (replaces any prior resources). */
export async function putSkillResources(
  skillId: string,
  resources: SkillResource[]
): Promise<void> {
  if (!resources || resources.length === 0) return;
  const safeResources = resources.filter((r) => isSafeResourcePath(r.path));
  if (safeResources.length === 0) return;
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    // Remove any previous resources for this skill, then write the fresh ones.
    const index = store.index("skillId");
    const keyReq = index.getAllKeys(IDBKeyRange.only(skillId));
    keyReq.onsuccess = () => {
      for (const key of keyReq.result) store.delete(key);
      for (const r of safeResources) {
        store.put({
          skillId,
          path: r.path,
          kind: r.kind,
          text: r.text,
          dataUrl: r.dataUrl,
        } satisfies StoredResource);
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to save skill resources"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Load all bundled resources for a skill. */
export async function getSkillResources(skillId: string): Promise<SkillResource[]> {
  const db = await openDb();
  return new Promise<SkillResource[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const index = store.index("skillId");
    const req = index.getAll(IDBKeyRange.only(skillId));
    req.onsuccess = () => {
      const rows = (req.result as StoredResource[]) ?? [];
      resolve(
        rows.map((r) => ({ path: r.path, kind: r.kind, text: r.text, dataUrl: r.dataUrl }))
      );
      db.close();
    };
    req.onerror = () => {
      reject(req.error ?? new Error("Failed to read skill resources"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Load a single bundled resource by skill id and path. Returns null when absent. */
export async function getSkillResource(
  skillId: string,
  path: string
): Promise<SkillResource | null> {
  return withStore("readonly", (store) =>
    store.get([skillId, path] as IDBValidKey)
  ).then((row: StoredResource | undefined) =>
    row ? { path: row.path, kind: row.kind, text: row.text, dataUrl: row.dataUrl } : null
  );
}

/** Persist a single bundled resource for a skill (upsert by skillId + path). */
export async function putSkillResource(
  skillId: string,
  resource: SkillResource
): Promise<void> {
  if (!resource || !resource.path) return;
  if (!isSafeResourcePath(resource.path)) {
    throw new Error(`Unsafe resource path: "${resource.path}"`);
  }
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put({
      skillId,
      path: resource.path,
      kind: resource.kind,
      text: resource.text,
      dataUrl: resource.dataUrl,
    } satisfies StoredResource);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to save skill resource"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Delete a single bundled resource by skill id and path. */
export async function deleteSkillResource(skillId: string, path: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.delete([skillId, path] as IDBValidKey);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to delete skill resource"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Rename a bundled resource (keeps content, moves key path). */
export async function renameSkillResource(
  skillId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (!newPath || newPath === oldPath) return;
  if (!isSafeResourcePath(newPath)) {
    throw new Error(`Unsafe destination path: "${newPath}"`);
  }
  const existing = await getSkillResource(skillId, oldPath);
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (existing) {
      store.put({
        skillId,
        path: newPath,
        kind: existing.kind,
        text: existing.text,
        dataUrl: existing.dataUrl,
      } satisfies StoredResource);
    }
    store.delete([skillId, oldPath] as IDBValidKey);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to rename skill resource"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/**
 * Rename every resource whose path is or is under a folder prefix (folders
 * are not real records - this is how a "folder rename" is expressed). Runs as
 * one transaction so a partial rename can't be left behind.
 */
export async function renameSkillResourcesByPrefix(
  skillId: string,
  oldPrefix: string,
  newPrefix: string
): Promise<void> {
  if (!newPrefix || newPrefix === oldPrefix) return;
  if (!isSafeResourcePath(newPrefix)) {
    throw new Error(`Unsafe destination path: "${newPrefix}"`);
  }
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index("skillId");
    const req = index.getAll(IDBKeyRange.only(skillId));
    req.onsuccess = () => {
      const rows = (req.result as StoredResource[]) ?? [];
      for (const row of rows) {
        if (row.path !== oldPrefix && !row.path.startsWith(`${oldPrefix}/`)) continue;
        const newPath = newPrefix + row.path.slice(oldPrefix.length);
        store.put({ ...row, path: newPath } satisfies StoredResource);
        store.delete([skillId, row.path] as IDBValidKey);
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to rename skill resources"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Delete every resource whose path is or is under a folder prefix. */
export async function deleteSkillResourcesByPrefix(skillId: string, prefix: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index("skillId");
    const req = index.getAll(IDBKeyRange.only(skillId));
    req.onsuccess = () => {
      const rows = (req.result as StoredResource[]) ?? [];
      for (const row of rows) {
        if (row.path !== prefix && !row.path.startsWith(`${prefix}/`)) continue;
        store.delete([skillId, row.path] as IDBValidKey);
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to delete skill resources"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}

/** Delete all bundled resources for a skill (call when the skill is removed). */
export async function deleteSkillResources(skillId: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index("skillId");
    const req = index.getAllKeys(IDBKeyRange.only(skillId));
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("Failed to delete skill resources"));
      try {
        db.close();
      } catch {
        /* ignore */
      }
    };
  });
}
