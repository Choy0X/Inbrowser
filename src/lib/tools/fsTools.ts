import type { ToolContext, ToolHandler } from "./types";
import { stringArg } from "./types";
import { vfsRead, vfsWrite, vfsList, vfsDelete, vfsMkdir, VfsPathError } from "../vfs/store";

/**
 * A persistent file system, scoped to the conversation/agent run it's used
 * in (ctx.convoId - "agent:<id>" for an agent, a real chat id otherwise).
 * Backed by OPFS: unlike run_code, this actually persists across separate
 * tool calls and separate runs. See lib/vfs/store.ts for why this uses
 * native OPFS rather than @zenfs/dom.
 */

function errorText(err: unknown): string {
  if (err instanceof VfsPathError) return err.message;
  if (err instanceof DOMException && err.name === "NotFoundError") return "No such file or directory.";
  if (err instanceof DOMException && err.name === "TypeMismatchError") return "That path is a directory, not a file (or vice versa).";
  return err instanceof Error ? err.message : String(err);
}

const fsRead: ToolHandler = {
  id: "fs_read",
  group: "fs",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "fs_read",
      description:
        "Read a text file from your persistent workspace. Files here survive across separate tool calls and " +
        "separate runs of this same agent - use it to build up notes, drafts or data over time, not just within one turn.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. 'notes/findings.md'." },
        },
        required: ["path"],
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const path = stringArg(args, "path");
    if (!path) return "Provide a path to read.";
    try {
      const text = await vfsRead(ctx.convoId, path);
      return text.length > 0 ? text : "(empty file)";
    } catch (err) {
      return `Could not read "${path}": ${errorText(err)}`;
    }
  },
};

const fsWrite: ToolHandler = {
  id: "fs_write",
  group: "fs",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "fs_write",
      description:
        "Write a text file to your persistent workspace, creating parent directories as needed. Overwrites " +
        "whatever was already at that path. This is for genuinely worth-keeping output - notes, drafts, data files - " +
        "not scratch text that only matters for the current step.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. 'notes/findings.md'." },
          content: { type: "string", description: "The full text content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const path = stringArg(args, "path");
    if (!path) return "Provide a path to write.";
    const content = typeof args.content === "string" ? args.content : "";
    try {
      await vfsWrite(ctx.convoId, path, content);
      return `Wrote ${content.length} characters to "${path}".`;
    } catch (err) {
      return `Could not write "${path}": ${errorText(err)}`;
    }
  },
};

const fsList: ToolHandler = {
  id: "fs_list",
  group: "fs",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "fs_list",
      description: "List the files and subdirectories at a path in your persistent workspace. Omit path to list the root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, e.g. 'notes'. Omit for the root." },
        },
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const path = stringArg(args, "path");
    try {
      const entries = await vfsList(ctx.convoId, path);
      if (entries.length === 0) return path ? `"${path}" is empty.` : "Your workspace is empty.";
      return entries.map((e) => (e.kind === "directory" ? `${e.name}/` : e.name)).join("\n");
    } catch (err) {
      return `Could not list "${path || "/"}": ${errorText(err)}`;
    }
  },
};

const fsDelete: ToolHandler = {
  id: "fs_delete",
  group: "fs",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "fs_delete",
      description: "Delete a file or directory (recursively) from your persistent workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete." },
        },
        required: ["path"],
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const path = stringArg(args, "path");
    if (!path) return "Provide a path to delete.";
    try {
      await vfsDelete(ctx.convoId, path);
      return `Deleted "${path}".`;
    } catch (err) {
      return `Could not delete "${path}": ${errorText(err)}`;
    }
  },
};

const fsMkdir: ToolHandler = {
  id: "fs_mkdir",
  group: "fs",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "fs_mkdir",
      description: "Create a directory (and any missing parent directories) in your persistent workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to create." },
        },
        required: ["path"],
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const path = stringArg(args, "path");
    if (!path) return "Provide a directory path to create.";
    try {
      await vfsMkdir(ctx.convoId, path);
      return `Created "${path}".`;
    } catch (err) {
      return `Could not create "${path}": ${errorText(err)}`;
    }
  },
};

export const FS_TOOL_HANDLERS: ToolHandler[] = [fsRead, fsWrite, fsList, fsDelete, fsMkdir];
