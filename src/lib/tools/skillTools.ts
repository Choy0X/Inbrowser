import { getSkillResource, getSkillResources } from "../skillstore";
import { skillSlug, truncateResourceText, type SkillResource } from "../skills";
import type { ToolContext, ToolHandler } from "./types";
import { stringArg } from "./types";

/**
 * Tools that let the model read the files bundled with an active skill.
 *
 * Moved out of App.tsx unchanged in behaviour: same two functions, same
 * disambiguation when several skills are active, and the same manifest
 * allowlist that stops a model reading anything the skill did not ship.
 */

/** Resolve which active skill a call refers to, or an explanatory message. */
async function resolveSkill(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ skillId: string } | { error: string }> {
  const active = ctx.activeSkills;
  if (active.size === 0) {
    return {
      error:
        "No skill is currently active in this conversation. Invoke a skill first (it injects its instructions), or ask the user to call one.",
    };
  }

  const names = () =>
    [...active.keys()]
      .map((id) => ctx.skills.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(", ");

  if (active.size === 1) return { skillId: [...active.keys()][0] };

  const requested = stringArg(args, "skill").toLowerCase();
  const match = requested
    ? [...active.keys()]
        .map((id) => ctx.skills.find((s) => s.id === id))
        .find((s) => s && (s.name.toLowerCase() === requested || skillSlug(s).toLowerCase() === requested))
    : undefined;

  if (!match) {
    return {
      error: requested
        ? `Unknown skill "${requested}". Active skills in this conversation: ${names()}. Pass the "skill" argument with one of these names.`
        : `Multiple skills are active in this conversation (${names()}). Pass the "skill" argument with the name of the one you mean.`,
    };
  }
  return { skillId: match.id };
}

async function resourcesFor(skillId: string, ctx: ToolContext): Promise<SkillResource[]> {
  const inline = ctx.activeSkills.get(skillId)?.resources;
  if (inline && inline.length > 0 && inline.some((r) => r.text !== undefined || r.dataUrl !== undefined)) {
    return inline;
  }
  return getSkillResources(skillId);
}

const listSkillFiles: ToolHandler = {
  id: "list_skill_files",
  group: "skills",
  applies: (ctx) => ctx.activeSkills.size > 0,
  def: {
    type: "function",
    function: {
      name: "list_skill_files",
      description:
        "List the paths of all resource files bundled with a skill that is currently active in this conversation.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "Name of the active skill to list files for. Only required when more than one skill is active in this conversation.",
          },
        },
      },
    },
  },
  async run(args, ctx) {
    const resolved = await resolveSkill(args, ctx);
    if ("error" in resolved) return resolved.error;
    const resources = await resourcesFor(resolved.skillId, ctx);
    if (resources.length === 0) return "This skill has no bundled resource files.";
    return resources.map((r) => r.path).join("\n");
  },
};

const readSkillFile: ToolHandler = {
  id: "read_skill_file",
  group: "skills",
  applies: (ctx) => ctx.activeSkills.size > 0,
  def: {
    type: "function",
    function: {
      name: "read_skill_file",
      description:
        "Read the contents of a resource file bundled with a skill that is currently active in this conversation. " +
        "Use this to access scripts, reference docs, templates or other files that ship with the skill.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative path of the bundled resource to read, e.g. 'scripts/build.py' or 'refs/README.md'. " +
              "List the available paths first if unsure (call list_skill_files).",
          },
          skill: {
            type: "string",
            description:
              "Name of the active skill to read from. Only required when more than one skill is active in this conversation.",
          },
        },
        required: ["path"],
      },
    },
  },
  async run(args, ctx) {
    const resolved = await resolveSkill(args, ctx);
    if ("error" in resolved) return resolved.error;

    const requested = stringArg(args, "path").replace(/\\/g, "/");
    if (!requested) return "Please provide a path to read (call list_skill_files for available paths).";

    // Restrict reads to the skill's own manifest, and reject traversal.
    const resources = await resourcesFor(resolved.skillId, ctx);
    const allowed = new Set(resources.map((r) => r.path.replace(/\\/g, "/")));
    const normalized = requested.replace(/^\.?\//, "");
    if (normalized.includes("..") || !allowed.has(normalized)) {
      return `Path "${requested}" is not a bundled resource of the active skill. Available files:\n${
        [...allowed].join("\n") || "(none)"
      }`;
    }

    const res = await getSkillResource(resolved.skillId, normalized);
    if (!res) return `File "${requested}" was not found in the skill's stored resources.`;
    if (res.kind === "image") return `[Image resource: ${res.path}]\n${res.dataUrl ?? ""}`;
    if (res.kind === "binary") {
      return `[Binary resource: ${res.path} - not text; described as a data URL if available.]\n${
        res.dataUrl ?? "(no text content)"
      }`;
    }
    return `[File: ${res.path}]\n${truncateResourceText(res.text ?? "")}`;
  },
};

export const SKILL_TOOL_HANDLERS: ToolHandler[] = [readSkillFile, listSkillFiles];
