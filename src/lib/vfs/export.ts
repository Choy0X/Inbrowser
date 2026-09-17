import { zipSync, unzipSync } from "fflate";
import { vfsWalk, vfsWrite, vfsMkdir } from "./store";

/**
 * Text-only, like the fs tools themselves (agent-authored code/markdown/JSON,
 * not arbitrary binary uploads) - importVfs decodes every entry as UTF-8, so a
 * genuinely binary file in an imported zip comes back corrupted rather than
 * silently dropped. A future binary-aware VfsEntry variant can lift this.
 */

/** Zip an agent's whole file tree, one entry per file, for download. */
export async function exportVfs(agentId: string): Promise<Blob> {
  const files = await vfsWalk(agentId);
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

/** Restore a zip (from exportVfs, or any plain zip) into an agent's file tree. Merges; does not clear first. */
export async function importVfs(agentId: string, input: ArrayBuffer | Uint8Array): Promise<{ fileCount: number }> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const unzipped = unzipSync(bytes);
  let fileCount = 0;
  for (const [path, data] of Object.entries(unzipped)) {
    if (path.endsWith("/")) {
      await vfsMkdir(agentId, path);
      continue;
    }
    await vfsWrite(agentId, path, new TextDecoder().decode(data));
    fileCount++;
  }
  return { fileCount };
}
