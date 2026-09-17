import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { newId } from "./store";

/** A resource file bundled inside a `.skill` archive. */
export interface SkillResource {
  /** Path relative to the skill's SKILL.md (e.g. "scripts/foo.py", "refs/README.md"). */
  path: string;
  kind: "text" | "image" | "binary";
  /** Text content for `kind === "text"` resources. */
  text?: string;
  /** Data URL for `kind === "image"` and `kind === "binary"` resources. */
  dataUrl?: string;
  /** Stable reference used to look the resource up in the resource store. */
  ref?: string;
}

/** Frontmatter fields beyond name/description, preserved verbatim from SKILL.md. */
export interface SkillMeta {
  license?: string;
  version?: string;
  allowedTools?: string[];
  /** Anything else the frontmatter carried, so nothing is silently dropped. */
  extra?: Record<string, unknown>;
}

export interface Skill {
  id: string;
  /** Display title. Derived from the frontmatter `name` when that is a kebab id. */
  name: string;
  /**
   * Canonical id from SKILL.md frontmatter (e.g. "brand-guidelines"). This is what
   * `/slug` resolves against, so an installed skill is invoked by its real name
   * rather than by a slugified display title.
   */
  slug?: string;
  description: string;
  /** Instructions/context injected when the skill is called into a chat. */
  instructions: string;
  enabled: boolean;
  builtin?: boolean;
  /**
   * Manifest of files bundled with this skill. Bodies live in IndexedDB
   * (see skillstore.ts); the copy persisted to localStorage is stripped to
   * path/kind/ref by `stripResourceBodies` so large skills cannot blow the
   * localStorage quota.
   */
  resources?: SkillResource[];
  meta?: SkillMeta;
  /** Provenance, set when a skill is installed from a marketplace. */
  version?: string;
  author?: string;
  license?: string;
  sourceUrl?: string;
  marketplaceId?: string;
  installedAt?: number;
}

/** Cap on inlined/returned resource text to avoid blowing up prompts or tool responses. */
export const SKILL_RESOURCE_TEXT_LIMIT = 20_000;

/** Per-file and per-skill limits applied while importing an archive. */
export const MAX_RESOURCE_BYTES = 2_000_000;
export const MAX_SKILL_BYTES = 25_000_000;

export function truncateResourceText(text: string, limit = SKILL_RESOURCE_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated, ${text.length - limit} characters omitted]`;
}

const KEY = "fachoy:skills:v1";

export const EXAMPLE_SKILLS: Skill[] = [
  {
    id: "skill-code-reviewer",
    name: "Code reviewer",
    description: "Carefully reviews code for bugs, style issues and edge cases.",
    instructions:
      "You are a thorough code reviewer. Review the code the user shares and report:\n" +
      "1. Bugs or correctness issues, with the exact lines.\n" +
      "2. Style and readability concerns.\n" +
      "3. Missing edge cases or error handling.\n" +
      "4. Concrete improvement suggestions with code.\n" +
      "Be precise and constructive; don't praise without pointing out concrete issues.",
    enabled: true,
    builtin: true,
  },
  {
    id: "skill-translator",
    name: "Translator",
    description: "Translates text between languages with nuance preserved.",
    instructions:
      "You are a professional translator. When the user gives text to translate, they will specify the target language. " +
      "Preserve tone, nuance and formatting. Provide only the translation unless the user asks for notes. " +
      "If the user did not specify a target language, ask which one they want.",
    enabled: true,
    builtin: true,
  },
];

export function defaultSkills(): Skill[] {
  return EXAMPLE_SKILLS.map((s) => ({ ...s }));
}

export function loadSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // merge with examples so bundled skills survive first load
        const ids = new Set(parsed.map((s) => s.id));
        const merged = [...parsed];
        for (const example of EXAMPLE_SKILLS) {
          if (!ids.has(example.id)) merged.push({ ...example });
        }
        return merged as Skill[];
      }
    }
  } catch {
    /* ignore */
  }
  return defaultSkills();
}

/**
 * Drops resource bodies (text / data URLs), keeping only the manifest.
 *
 * Resource content belongs in IndexedDB (skillstore.ts). Persisting it here as
 * well would duplicate every bundled file into localStorage - a real skill that
 * ships fonts or images exceeds the quota, and `saveSkills` swallows the error,
 * so the skill would silently fail to save.
 */
export function stripResourceBodies(skill: Skill): Skill {
  if (!skill.resources || skill.resources.length === 0) return skill;
  return {
    ...skill,
    resources: skill.resources.map((r) => ({
      path: r.path,
      kind: r.kind,
      ...(r.ref ? { ref: r.ref } : {}),
    })),
  };
}

export function saveSkills(skills: Skill[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(skills.map(stripResourceBodies)));
  } catch {
    /* ignore */
  }
}

/**
 * Parse a `.skill` file into one or more Skills.
 *
 * A `.skill` file is a ZIP archive (Agent Skills convention) containing one or
 * more `SKILL.md` files, each with its bundled resources alongside it. Real
 * skill repositories ship many skills in one tree (e.g. `skills/<name>/SKILL.md`),
 * so every SKILL.md becomes its own Skill and each skill's resources are stored
 * relative to its own directory. A plain markdown `.skill` file (the single-skill
 * format this app exports) is also accepted.
 *
 * Throws a clear Error when the input isn't a valid skill.
 */
export function parseSkillFileAll(input: string | Uint8Array | ArrayBuffer): Skill[] {
  if (typeof input === "string") {
    return [parseSkillMarkdown(input)];
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isZip(bytes)) {
    return parseSkillArchive(bytes);
  }
  // Not a zip - fall back to a plain markdown skill file.
  const text = strFromU8(bytes);
  try {
    return [parseSkillMarkdown(text)];
  } catch (err) {
    throw new Error(
      "This file doesn't appear to be a valid .skill file (not a ZIP archive and not markdown).",
      { cause: err }
    );
  }
}

/** Back-compat single-skill entry point: returns the first skill in the file. */
export function parseSkillFile(input: string | Uint8Array | ArrayBuffer): Skill {
  return parseSkillFileAll(input)[0];
}

/** Turn a kebab/snake frontmatter id into a display title ("brand-guidelines" -> "Brand guidelines"). */
function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (!words) return slug;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Parse a plain-text (non-zip) `.skill` markdown file. */
function parseSkillMarkdown(text: string): Skill {
  const normalized = text.replace(/^﻿/, "");
  const fm = extractFrontmatter(normalized);
  let meta: Record<string, unknown> = {};
  let body = normalized.trim();
  if (fm) {
    meta = (yamlLoad(fm.raw) as Record<string, unknown>) ?? {};
    body = fm.body.trim();
  }

  const rawName = typeof meta.name === "string" ? meta.name.trim() : "";
  const rawDescription = typeof meta.description === "string" ? meta.description.trim() : "";

  // Agent Skills frontmatter `name` is a kebab id, not a title. Keep it as the
  // canonical slug so `/brand-guidelines` resolves, and show a readable title.
  const isSlugLike = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(rawName);
  const slug = isSlugLike ? rawName : slugify(rawName);
  const name = rawName ? (isSlugLike ? titleFromSlug(rawName) : rawName) : nameFromBody(body);
  const description = rawDescription || firstSentence(body);
  const instructions = body || rawDescription || rawName;

  if (!name.trim()) throw new Error("Skill is missing a name.");
  if (!instructions.trim()) throw new Error("Skill has no instructions.");

  const skillMeta = collectMeta(meta);

  return {
    id: newId(),
    name,
    ...(slug ? { slug } : {}),
    description,
    instructions,
    enabled: true,
    builtin: false,
    ...(skillMeta ? { meta: skillMeta } : {}),
    ...(typeof meta.version === "string" ? { version: meta.version } : {}),
    ...(typeof meta.license === "string" ? { license: meta.license } : {}),
  };
}

/** Preserve every frontmatter field we don't already model, so nothing is dropped. */
function collectMeta(meta: Record<string, unknown>): SkillMeta | null {
  const known = new Set(["name", "description"]);
  const out: SkillMeta = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (known.has(key)) continue;
    if (key === "license" && typeof value === "string") {
      out.license = value;
    } else if (key === "version" && typeof value === "string") {
      out.version = value;
    } else if (key === "allowed-tools" || key === "allowedTools") {
      if (Array.isArray(value)) out.allowedTools = value.map(String);
      else if (typeof value === "string") {
        out.allowedTools = value.split(",").map((s) => s.trim()).filter(Boolean);
      }
    } else {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return Object.keys(out).length > 0 ? out : null;
}

/** Archive entries that are never part of a skill. */
const JUNK = /(^|\/)(\.git|node_modules|__MACOSX|\.idea|\.vscode)\/|(^|\/)(\.DS_Store|Thumbs\.db)$/i;

/**
 * Parse a `.skill` ZIP archive into every skill it contains. Each SKILL.md
 * defines one skill whose resources are the files under its own directory,
 * stored with paths relative to that directory so they match the references
 * inside SKILL.md (and therefore the read_skill_file tool's allowlist).
 */
function parseSkillArchive(bytes: Uint8Array): Skill[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This .skill file is a ZIP archive but it couldn't be unzipped.");
  }

  const paths = Object.keys(files);
  // Normalise to forward slashes for consistent matching.
  const norm = paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  const skillPaths = locateAllSkillMd(norm);
  if (skillPaths.length === 0) {
    throw new Error("No SKILL.md found in this .skill archive.");
  }

  // A skill owns the files under its own directory, but not those belonging to
  // a more deeply nested skill.
  const dirs = skillPaths.map(dirOf);
  const skills: Skill[] = [];

  for (const skillPath of skillPaths) {
    const dir = dirOf(skillPath);
    const skill = parseSkillMarkdown(strFromU8(files[paths[norm.indexOf(skillPath)]]));

    const resources: SkillResource[] = [];
    let total = 0;
    for (let i = 0; i < norm.length; i++) {
      const p = norm[i];
      if (p === skillPath || JUNK.test(p)) continue;
      if (!isUnder(p, dir)) continue;
      // Skip files that belong to a more deeply nested skill of its own.
      if (dirs.some((d) => d !== dir && d.length > dir.length && isUnder(p, d))) continue;

      const data = files[paths[i]];
      if (data.length > MAX_RESOURCE_BYTES) continue;
      if (total + data.length > MAX_SKILL_BYTES) break;

      const res = toResource(relativeTo(p, dir), data);
      if (res) {
        resources.push(res);
        total += data.length;
      }
    }
    if (resources.length > 0) skill.resources = resources;
    skills.push(skill);
  }
  return skills;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function isUnder(path: string, dir: string): boolean {
  return dir === "" ? true : path.startsWith(`${dir}/`);
}

function relativeTo(path: string, dir: string): string {
  return dir === "" ? path : path.slice(dir.length + 1);
}

/** Every SKILL.md entry in the archive, shallowest first, case-insensitive. */
export function locateAllSkillMd(paths: string[]): string[] {
  return paths
    .filter((p) => {
      const base = (p.split("/").pop() ?? p).toLowerCase();
      return base === "skill.md";
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "c", "cpp", "h", "hpp", "java",
  "css", "scss", "less", "html", "htm", "xml", "sh", "bat", "ps1", "sql", "csv",
  "env", "gitignore", "log", "diff", "patch", "svg",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** Convert one archive entry into a SkillResource, or null when it's a directory marker. */
function toResource(path: string, data: Uint8Array): SkillResource | null {
  if (!isSafeResourcePath(path)) return null;
  if (path === "" || path.endsWith("/") || path.endsWith("\\")) return null; // directory entry
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const mime =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : `image/${ext}`;
    return { path, kind: "image", dataUrl: `data:${mime};base64,${toBase64(data)}` };
  }
  if (TEXT_EXT.has(ext)) {
    return { path, kind: "text", text: strFromU8(data) };
  }
  // Unknown extension - treat as text if it looks printable, else binary.
  const sample = new TextDecoder().decode(data.slice(0, 4096)).replace(/\x00/g, "");
  if (/[\x00-\x08\x0e-\x1f]/.test(sample.slice(0, 512))) {
    return { path, kind: "binary", dataUrl: `data:application/octet-stream;base64,${toBase64(data)}` };
  }
  return { path, kind: "text", text: new TextDecoder().decode(data) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Detect the ZIP local-file-header magic bytes ("PK\x03\x04"). */
function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04
  );
}

/** Serialize a Skill's SKILL.md (frontmatter + instructions). */
export function serializeSkillFile(skill: Skill): string {
  const fm: Record<string, unknown> = {
    name: skill.slug || slugify(skill.name) || skill.id,
    description: skill.description,
  };
  const license = skill.license ?? skill.meta?.license;
  const version = skill.version ?? skill.meta?.version;
  if (license) fm.license = license;
  if (version) fm.version = version;
  if (skill.meta?.allowedTools?.length) fm["allowed-tools"] = skill.meta.allowedTools;
  for (const [k, v] of Object.entries(skill.meta?.extra ?? {})) fm[k] = v;

  const frontmatter = yamlDump(fm).replace(/\n$/, "");
  const body = (skill.instructions ?? "").trim();
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** Turn a resource back into raw bytes for export. */
function resourceBytes(res: SkillResource): Uint8Array | null {
  if (res.kind === "text") return typeof res.text === "string" ? strToU8(res.text) : null;
  if (res.dataUrl) {
    try {
      return fromBase64(res.dataUrl);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a zip Blob containing one directory per skill (SKILL.md plus every
 * bundled resource), so export/import round-trips without losing files.
 * `loadResources` supplies bodies, which live in IndexedDB rather than on the
 * Skill record.
 */
export async function exportSkillsZip(
  skills: Skill[],
  loadResources?: (skillId: string) => Promise<SkillResource[]>,
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const names = new Set<string>();
  for (const skill of skills) {
    const base = skill.slug || slugify(skill.name) || "skill";
    let dir = base;
    let i = 2;
    while (names.has(dir)) dir = `${base}-${i++}`;
    names.add(dir);

    files[`${dir}/SKILL.md`] = strToU8(serializeSkillFile(skill));

    let resources = skill.resources ?? [];
    const needsBodies = resources.some((r) => r.text === undefined && r.dataUrl === undefined);
    if (loadResources && (needsBodies || resources.length === 0)) {
      try {
        resources = await loadResources(skill.id);
      } catch {
        /* best effort - export the SKILL.md even if resources can't be read */
      }
    }
    for (const res of resources) {
      if (!isSafeResourcePath(res.path)) continue;
      const bytes = resourceBytes(res);
      if (bytes) files[`${dir}/${res.path}`] = bytes;
    }
  }
  const zipped = zipSync(files);
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

interface Frontmatter {
  raw: string;
  body: string;
}

/** Requires the closing `---` to be alone on its own line, so `----` in the body is safe. */
function extractFrontmatter(text: string): Frontmatter | null {
  const trimmed = text.trimStart();
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(trimmed);
  if (!match) return null;
  return { raw: match[1], body: trimmed.slice(match[0].length) };
}

function nameFromBody(body: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const firstLine = body.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 60) : "";
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/[#*`>_\-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const dot = cleaned.search(/[.!?](?:\s|$)/);
  return dot === -1 ? cleaned.slice(0, 90) : cleaned.slice(0, dot + 1).trim();
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function newSkill(name: string, description: string, instructions: string): Skill {
  const trimmedName = name.trim();
  const slug = slugify(trimmedName);
  return {
    id: newId(),
    name: trimmedName,
    description: description.trim(),
    instructions: instructions.trim(),
    enabled: true,
    ...(slug ? { slug } : {}),
  };
}

/** Whether a single path segment (a file/folder basename) is safe to store. */
export function isSafeResourceSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\");
}

/**
 * Validates a full SkillResource.path: forward-slash-delimited, relative to
 * the skill's own directory, with no segment that could escape it.
 */
export function isSafeResourcePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false; // e.g. "C:\..." or "C:evil"
  return path.split("/").every(isSafeResourceSegment);
}

/** The `/<slug>` a skill is called with - the frontmatter id when it has one. */
export function skillSlug(skill: Skill): string {
  return skill.slug || slugify(skill.name) || skill.id;
}

/** Maps every skill's current slug to itself, for resolving typed/pasted `/<slug>` text. */
export function resolveSkillSlugs(skills: Skill[]): Map<string, Skill> {
  const map = new Map<string, Skill>();
  for (const skill of skills) map.set(skillSlug(skill), skill);
  return map;
}

/**
 * Finds every `/<slug>` skill-token occurrence in plain text (as sent in a
 * message once tokens are serialized to their slug form), de-duplicated in
 * first-occurrence order.
 */
export function findSkillTokensInText(text: string, skills: Skill[]): Skill[] {
  const bySlug = resolveSkillSlugs(skills);
  const found: Skill[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)\/([a-z0-9-]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const skill = bySlug.get(match[2].toLowerCase());
    if (skill && !seen.has(skill.id)) {
      seen.add(skill.id);
      found.push(skill);
    }
  }
  return found;
}

export type SkillTextSegment = { text: string } | { skill: Skill; raw: string };

/**
 * Splits plain text (a sent message's stored content) into plain-text and
 * skill-token segments, so a transcript can render `/<slug>` the same way
 * the composer renders it live - a highlighted, clickable pill - instead of
 * inert text. Non-matching `/word`s (not a known skill) are left as plain text.
 */
export function splitTextBySkillTokens(text: string, skills: Skill[]): SkillTextSegment[] {
  const bySlug = resolveSkillSlugs(skills);
  const segments: SkillTextSegment[] = [];
  const re = /(^|\s)\/([a-z0-9-]+)\b/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const skill = bySlug.get(match[2].toLowerCase());
    if (!skill) continue;
    const tokenStart = match.index + match[1].length;
    const tokenEnd = tokenStart + 1 + match[2].length;
    if (tokenStart > lastIndex) segments.push({ text: text.slice(lastIndex, tokenStart) });
    segments.push({ skill, raw: text.slice(tokenStart, tokenEnd) });
    lastIndex = tokenEnd;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}
