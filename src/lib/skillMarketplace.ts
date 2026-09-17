import type { Skill, SkillResource } from "./skills";
import { slugify } from "./skills";
import { newId } from "./store";

/**
 * Third-party skill store.
 *
 * There is no need to invent a catalog format: Anthropic already publishes one
 * for Agent Skills - a `.claude-plugin/marketplace.json` at the root of a repo,
 * listing plugins and the skill directories each contains. InBrowser can therefore
 * install from *any* GitHub repo that publishes that file, which makes the
 * store genuinely open rather than a list we control.
 *
 * Every endpoint used here was checked to send CORS headers, because the app
 * has no server to fetch through:
 *   api.github.com          ACAO *   (60 req/hr per client IP; the /search
 *                                     endpoints are stricter still, 10 req/10min
 *                                     unauthenticated - see searchMarketplaces)
 *   cdn.jsdelivr.net/gh     ACAO *   (file contents)
 *   data.jsdelivr.com/v1    ACAO *   (file listing)
 *
 * codeload.github.com zipballs are NOT usable - their ACAO is restricted to
 * GitHub's own renderer - so a skill is assembled file by file from the
 * jsDelivr tree rather than downloaded as an archive. That also sidesteps
 * picking the wrong SKILL.md out of a repo full of them.
 */

const GH_API = "https://api.github.com";
const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";
const JSDELIVR_DATA = "https://data.jsdelivr.com/v1/packages/gh";

/**
 * Ships configured so the store is useful the moment it is opened.
 *
 * Only the first-party `anthropics/skills` is `trusted: true`. The other two
 * are real, org-owned repos (confirmed against the GitHub API before adding),
 * but "trusted" governs a UI badge users rely on to gauge risk, and nothing
 * here re-reviews their history on every future commit to `main` - so they
 * ship the same way a repo a user adds themselves would: untrusted by
 * default, same as everyone else's unreviewed third-party content.
 */
export const DEFAULT_MARKETPLACES: MarketplaceRef[] = [
  { repo: "anthropics/skills", ref: "main", trusted: true },
  { repo: "supabase/agent-skills", ref: "main" },
  { repo: "vercel-labs/agent-skills", ref: "main" },
];

export interface MarketplaceRef {
  /** "owner/name" on GitHub. */
  repo: string;
  ref: string;
  /** Bundled defaults are trusted; anything the user adds starts untrusted. */
  trusted?: boolean;
}

export interface MarketplaceSkill {
  /** Stable identity: repo + path. */
  id: string;
  repo: string;
  ref: string;
  /** Directory inside the repo, e.g. "skills/brand-guidelines". */
  path: string;
  name: string;
  description: string;
  /** The plugin grouping this skill was listed under. */
  collection: string;
  sourceUrl: string;
}

export interface Marketplace {
  repo: string;
  ref: string;
  name: string;
  description: string;
  owner: string;
  version?: string;
  skills: MarketplaceSkill[];
  trusted: boolean;
}

interface MarketplaceManifest {
  name?: string;
  owner?: { name?: string } | string;
  metadata?: { description?: string; version?: string };
  plugins?: { name?: string; description?: string; source?: string; skills?: string[] }[];
}

interface JsDelivrFile {
  name: string;
  size: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

function cleanPath(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * Read a repo's marketplace manifest and flatten it into installable skills.
 *
 * Only understands the flat `plugins[].skills: string[]` shape. Some real,
 * well-formed marketplaces (e.g. MiniMax-AI/skills) instead use
 * `plugins[].source: "./some/folder"`, pointing at a plugin's own directory
 * rather than listing skill paths directly - a manifest shape this doesn't
 * parse, not an absence of skills. Throwing when a manifest exists but
 * produced nothing lets `loadMarketplace`'s fallback take over and scan the
 * repo directly for SKILL.md files, which finds them correctly. Succeeding
 * here with an empty list would instead make the marketplace silently
 * vanish - it fetched fine, so `loadMarketplace`'s try/catch never reaches
 * the fallback, and the UI shows neither skills nor an error.
 */
export async function fetchMarketplace(ref: MarketplaceRef, signal?: AbortSignal): Promise<Marketplace> {
  const manifest = await getJson<MarketplaceManifest>(
    `${JSDELIVR_CDN}/${ref.repo}@${ref.ref}/.claude-plugin/marketplace.json`,
    signal
  );

  const skills: MarketplaceSkill[] = [];
  for (const plugin of manifest.plugins ?? []) {
    for (const path of plugin.skills ?? []) {
      const dir = cleanPath(path);
      if (!dir) continue;
      skills.push({
        id: `${ref.repo}#${dir}`,
        repo: ref.repo,
        ref: ref.ref,
        path: dir,
        name: dir.split("/").pop() ?? dir,
        description: plugin.description ?? "",
        collection: plugin.name ?? "skills",
        sourceUrl: `https://github.com/${ref.repo}/tree/${ref.ref}/${dir}`,
      });
    }
  }

  if (skills.length === 0 && (manifest.plugins?.length ?? 0) > 0) {
    throw new Error(`${ref.repo}'s marketplace.json uses a plugin shape with no skills array.`);
  }

  const owner = typeof manifest.owner === "string" ? manifest.owner : manifest.owner?.name;
  return {
    repo: ref.repo,
    ref: ref.ref,
    name: manifest.name ?? ref.repo,
    description: manifest.metadata?.description ?? "",
    owner: owner ?? ref.repo.split("/")[0],
    version: manifest.metadata?.version,
    skills,
    trusted: ref.trusted ?? false,
  };
}

/**
 * Fall back to scanning the file tree for SKILL.md when a repo has no marketplace
 * manifest, so an ordinary skills repo still installs.
 */
export async function discoverSkillsWithoutManifest(
  ref: MarketplaceRef,
  signal?: AbortSignal
): Promise<MarketplaceSkill[]> {
  const tree = await getJson<{ files: JsDelivrFile[] }>(
    `${JSDELIVR_DATA}/${ref.repo}@${ref.ref}?structure=flat`,
    signal
  );
  return tree.files
    .map((f) => cleanPath(f.name))
    .filter((name) => name.toLowerCase().endsWith("/skill.md"))
    .map((name) => {
      const dir = name.slice(0, name.lastIndexOf("/"));
      return {
        id: `${ref.repo}#${dir}`,
        repo: ref.repo,
        ref: ref.ref,
        path: dir,
        name: dir.split("/").pop() ?? dir,
        description: "",
        collection: "discovered",
        sourceUrl: `https://github.com/${ref.repo}/tree/${ref.ref}/${dir}`,
      };
    });
}

/** Load a marketplace, tolerating repos that only have loose skill folders. */
export async function loadMarketplace(ref: MarketplaceRef, signal?: AbortSignal): Promise<Marketplace> {
  try {
    return await fetchMarketplace(ref, signal);
  } catch {
    const skills = await discoverSkillsWithoutManifest(ref, signal);
    if (skills.length === 0) {
      throw new Error(
        `${ref.repo} has no .claude-plugin/marketplace.json and no SKILL.md files. Is it a skills repo?`
      );
    }
    return {
      repo: ref.repo,
      ref: ref.ref,
      name: ref.repo,
      description: "Skills discovered by scanning the repository.",
      owner: ref.repo.split("/")[0],
      skills,
      trusted: ref.trusted ?? false,
    };
  }
}

/** Thrown by `searchMarketplaces` when GitHub's search-specific rate limit is hit. */
export class GitHubRateLimitError extends Error {
  constructor(public resetAt: number | null) {
    super("GitHub search rate limit reached.");
    this.name = "GitHubRateLimitError";
  }
}

/**
 * Search GitHub for repos that look like skill marketplaces.
 *
 * Deliberately no `sort=stars`: it discards relevance entirely and surfaces
 * huge unrelated repos (a query for "seo claude skills" sorted by stars
 * returned `public-apis/public-apis` as the top hit) - GitHub's default
 * best-match sort is what actually answers the query.
 */
export async function searchMarketplaces(query: string, signal?: AbortSignal): Promise<
  { repo: string; description: string; stars: number }[]
> {
  const q = query.trim()
    ? `${query} claude skills in:name,description,readme`
    : "claude skills in:name,description";
  const url = `${GH_API}/search/repositories?q=${encodeURIComponent(q)}&per_page=20`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });

  if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
    const resetHeader = res.headers.get("x-ratelimit-reset");
    throw new GitHubRateLimitError(resetHeader ? Number(resetHeader) * 1000 : null);
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);

  const data = (await res.json()) as {
    items?: { full_name: string; description: string | null; stargazers_count: number }[];
  };
  return (data.items ?? []).map((item) => ({
    repo: item.full_name,
    description: item.description ?? "",
    stars: item.stargazers_count,
  }));
}

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "js", "jsx", "ts", "tsx",
  "py", "rb", "go", "rs", "sh", "html", "css", "xml", "sql", "svg",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico"]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 60;

async function fetchResource(
  entry: MarketplaceSkill,
  relPath: string,
  signal?: AbortSignal
): Promise<SkillResource | null> {
  const url = `${JSDELIVR_CDN}/${entry.repo}@${entry.ref}/${entry.path}/${relPath}`;
  const ext = (relPath.split(".").pop() ?? "").toLowerCase();
  const res = await fetch(url, { signal });
  if (!res.ok) return null;

  if (IMAGE_EXT.has(ext)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { path: relPath, kind: "image", dataUrl: `data:${mime};base64,${btoa(binary)}` };
  }
  if (TEXT_EXT.has(ext) || !ext) {
    return { path: relPath, kind: "text", text: await res.text() };
  }
  // Anything else is skipped rather than base64-inflated into storage.
  return null;
}

export interface FetchedSkill {
  skill: Skill;
  resources: SkillResource[];
}

/**
 * Assemble one catalog entry into a Skill plus its resources, fetched file by
 * file with paths relative to its own SKILL.md - the shape read_skill_file
 * expects.
 */
export async function installSkill(
  entry: MarketplaceSkill,
  parse: (markdown: string) => Skill,
  signal?: AbortSignal
): Promise<FetchedSkill> {
  const tree = await getJson<{ files: JsDelivrFile[] }>(
    `${JSDELIVR_DATA}/${entry.repo}@${entry.ref}?structure=flat`,
    signal
  );

  const prefix = `${entry.path}/`;
  const owned = tree.files
    .map((f) => ({ path: cleanPath(f.name), size: f.size }))
    .filter((f) => f.path.startsWith(prefix));

  const skillMd = owned.find((f) => f.path.toLowerCase() === `${prefix.toLowerCase()}skill.md`);
  if (!skillMd) throw new Error(`No SKILL.md found in ${entry.repo}/${entry.path}.`);

  const markdown = await fetch(`${JSDELIVR_CDN}/${entry.repo}@${entry.ref}/${skillMd.path}`, { signal });
  if (!markdown.ok) throw new Error(`Could not read SKILL.md (${markdown.status}).`);
  const skill = parse(await markdown.text());

  const resources: SkillResource[] = [];
  for (const file of owned) {
    if (resources.length >= MAX_FILES) break;
    if (file.path === skillMd.path || file.size > MAX_FILE_BYTES) continue;
    const rel = file.path.slice(prefix.length);
    const resource = await fetchResource(entry, rel, signal).catch(() => null);
    if (resource) resources.push(resource);
  }

  return {
    skill: {
      ...skill,
      id: newId(),
      slug: skill.slug || slugify(entry.name),
      sourceUrl: entry.sourceUrl,
      marketplaceId: entry.repo,
      installedAt: Date.now(),
      resources,
    },
    resources,
  };
}

/** Preview a skill's instructions before installing, so nothing installs unread. */
export async function previewSkill(entry: MarketplaceSkill, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${JSDELIVR_CDN}/${entry.repo}@${entry.ref}/${entry.path}/SKILL.md`, { signal });
  if (!res.ok) throw new Error(`Could not read SKILL.md (${res.status}).`);
  return res.text();
}

const STORE_KEY = "fachoy:marketplaces:v1";

export function loadMarketplaceRefs(): MarketplaceRef[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set(parsed.map((m: MarketplaceRef) => m.repo));
        return [...parsed, ...DEFAULT_MARKETPLACES.filter((m) => !seen.has(m.repo))];
      }
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_MARKETPLACES];
}

export function saveMarketplaceRefs(refs: MarketplaceRef[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(refs));
  } catch {
    /* ignore */
  }
}

const GITHUB_URL_RE = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i;
const PLAIN_REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;

/** Accepts "owner/repo" or any github.com URL pointing at one. */
export function parseRepoInput(input: string): MarketplaceRef {
  const trimmed = input.trim();
  const url = trimmed.match(GITHUB_URL_RE);
  if (url) return { repo: `${url[1]}/${url[2].replace(/\.git$/, "")}`, ref: "main" };
  const plain = trimmed.match(PLAIN_REPO_RE);
  if (plain) return { repo: `${plain[1]}/${plain[2]}`, ref: "main" };
  throw new Error('Enter a repository as "owner/name" or a github.com URL.');
}

/** True when the input already looks like a direct owner/repo or github.com URL. */
export function isRepoShaped(input: string): boolean {
  const trimmed = input.trim();
  return GITHUB_URL_RE.test(trimmed) || PLAIN_REPO_RE.test(trimmed);
}
