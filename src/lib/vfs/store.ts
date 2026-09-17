/**
 * Per-agent persistent file system, backed by the real Origin Private File
 * System - durable across runs and conversations, exportable as a zip.
 *
 * Deliberately native OPFS APIs, not @zenfs/dom's WebAccessFS: that library's
 * async write-back queue has a reproducible byte-corruption bug on this
 * OPFS backend (verified directly against raw on-disk bytes during the
 * Agents Builder spike). Native FileSystemDirectoryHandle/FileSystemFileHandle
 * is well-supported, fully async, and never touches that code path - it's
 * only run_shell (wasi-sh's pluggable `fs:` seam) that needs a ZenFS-shaped
 * synchronous filesystem, and that tool ships v1 on an in-memory store for
 * exactly this reason.
 */

const ROOT_DIR = "fachoy-agent-fs";

export class VfsPathError extends Error {}

/** Split, validate and reject traversal/empty segments. Leading/trailing slashes are ignored. */
function segments(path: string): string[] {
  const parts = path.split("/").filter((s) => s.length > 0);
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new VfsPathError(`Path "${path}" is not allowed: "${part}" segments are rejected.`);
    }
  }
  return parts;
}

async function agentRoot(agentId: string): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory();
  const fsRoot = await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true });
  return fsRoot.getDirectoryHandle(agentId, { create: true });
}

/** Resolve every directory segment but the last, creating them if `create`. */
async function resolveDir(
  agentId: string,
  dirParts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = await agentRoot(agentId);
  for (const part of dirParts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

export interface VfsEntry {
  name: string;
  kind: "file" | "directory";
}

export async function vfsRead(agentId: string, path: string): Promise<string> {
  const parts = segments(path);
  if (parts.length === 0) throw new VfsPathError("A file path is required.");
  const dir = await resolveDir(agentId, parts.slice(0, -1), false);
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();
  return file.text();
}

export async function vfsWrite(agentId: string, path: string, content: string): Promise<void> {
  const parts = segments(path);
  if (parts.length === 0) throw new VfsPathError("A file path is required.");
  const dir = await resolveDir(agentId, parts.slice(0, -1), true);
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

export async function vfsList(agentId: string, path: string): Promise<VfsEntry[]> {
  const parts = segments(path);
  const dir = await resolveDir(agentId, parts, false);
  const entries: VfsEntry[] = [];
  // @ts-expect-error - FileSystemDirectoryHandle is async-iterable at runtime; lib.dom's types lag the spec.
  for await (const [name, handle] of dir.entries()) {
    entries.push({ name, kind: handle.kind });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export async function vfsDelete(agentId: string, path: string): Promise<void> {
  const parts = segments(path);
  if (parts.length === 0) throw new VfsPathError("A path is required.");
  const dir = await resolveDir(agentId, parts.slice(0, -1), false);
  await dir.removeEntry(parts[parts.length - 1], { recursive: true });
}

export async function vfsMkdir(agentId: string, path: string): Promise<void> {
  const parts = segments(path);
  if (parts.length === 0) throw new VfsPathError("A directory path is required.");
  await resolveDir(agentId, parts, true);
}

/** Walk the whole tree as flat path -> bytes, for zip export. */
export async function vfsWalk(agentId: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    // @ts-expect-error - see vfsList above.
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        out[path] = new Uint8Array(await file.arrayBuffer());
      } else {
        await walk(handle as FileSystemDirectoryHandle, path);
      }
    }
  }
  await walk(await agentRoot(agentId), "");
  return out;
}

/** Total bytes used, for a storage-usage display. */
export async function vfsUsageBytes(agentId: string): Promise<number> {
  const files = await vfsWalk(agentId);
  return Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);
}
