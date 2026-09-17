import type { ToolPluginSpec } from "./toolPlugins";

/**
 * First-party tool plugins.
 *
 * Deliberately small, dependency-free utilities. Each one exists because a
 * model is unreliable at it but a few lines of code are exact - hashing, base64,
 * date arithmetic, contrast ratios. Anything needing a real library belongs in
 * a runtime instead.
 *
 * This module is only imported when a tool plugin is enabled, so the whole
 * catalogue costs nothing to users who never turn one on.
 */

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string).trim() : "";

function obj(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "function" as const,
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

// ---------------------------------------------------------------- text

const regexTester: ToolPluginSpec = {
  id: "tool-regex",
  name: "Regex tester",
  description: "Test a regular expression against sample text and see every match with its capture groups.",
  tags: ["text", "regex", "developer"],
  def: obj(
    "regex_test",
    "Test a JavaScript regular expression against text and return every match with capture groups and indices.",
    {
      pattern: { type: "string", description: "The regular expression source, without delimiters." },
      flags: { type: "string", description: "Regex flags, e.g. 'gi'. Defaults to 'g'." },
      text: { type: "string", description: "The text to match against." },
    },
    ["pattern", "text"]
  ),
  run(args) {
    const flags = str(args, "flags") || "g";
    const re = new RegExp(str(args, "pattern"), flags.includes("g") ? flags : `${flags}g`);
    const text = str(args, "text");
    const out: string[] = [];
    for (const m of text.matchAll(re)) {
      const groups = m.slice(1).map((g, i) => `  $${i + 1} = ${g === undefined ? "(unset)" : JSON.stringify(g)}`);
      out.push(`@${m.index}: ${JSON.stringify(m[0])}${groups.length ? `\n${groups.join("\n")}` : ""}`);
      if (out.length >= 100) break;
    }
    return out.length ? `${out.length} match(es):\n${out.join("\n")}` : "No matches.";
  },
};

const textStats: ToolPluginSpec = {
  id: "tool-text-stats",
  name: "Text statistics",
  description: "Count characters, words, lines and a rough token estimate for a block of text.",
  tags: ["text", "writing"],
  def: obj(
    "text_stats",
    "Count characters, words, lines, sentences and estimate tokens for a block of text.",
    { text: { type: "string", description: "The text to measure." } },
    ["text"]
  ),
  run(args) {
    const text = typeof args.text === "string" ? args.text : "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const sentences = (text.match(/[.!?](\s|$)/g) ?? []).length;
    return [
      `characters: ${text.length}`,
      `characters (no spaces): ${text.replace(/\s/g, "").length}`,
      `words: ${words}`,
      `lines: ${text ? text.split(/\r?\n/).length : 0}`,
      `sentences: ${sentences}`,
      // ~4 chars per token is the usual rule of thumb; stated as an estimate.
      `estimated tokens: ~${Math.ceil(text.length / 4)}`,
    ].join("\n");
  },
};

const diffTool: ToolPluginSpec = {
  id: "tool-diff",
  name: "Text diff",
  description: "Compare two blocks of text line by line and show what changed.",
  tags: ["text", "developer"],
  def: obj(
    "text_diff",
    "Compare two texts line by line and return a unified-style diff of what changed.",
    { before: { type: "string" }, after: { type: "string" } },
    ["before", "after"]
  ),
  run(args) {
    const a = (typeof args.before === "string" ? args.before : "").split(/\r?\n/);
    const b = (typeof args.after === "string" ? args.after : "").split(/\r?\n/);
    // Longest common subsequence, which keeps unchanged lines aligned instead
    // of reporting the whole file as changed after a single insertion.
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        out.push(`  ${a[i]}`);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push(`- ${a[i++]}`);
      } else {
        out.push(`+ ${b[j++]}`);
      }
    }
    while (i < a.length) out.push(`- ${a[i++]}`);
    while (j < b.length) out.push(`+ ${b[j++]}`);
    const changed = out.filter((l) => l[0] !== " ").length;
    return changed === 0 ? "The two texts are identical." : `${changed} changed line(s):\n${out.join("\n")}`;
  },
};

// ---------------------------------------------------------------- data

const jsonYaml: ToolPluginSpec = {
  id: "tool-json",
  name: "JSON tools",
  description: "Validate, format, minify or query JSON with a dotted path.",
  tags: ["data", "json", "developer"],
  def: obj(
    "json_tool",
    "Validate, pretty-print, minify or query a JSON document. Use this instead of parsing JSON by eye.",
    {
      json: { type: "string", description: "The JSON document." },
      action: { type: "string", description: "One of: format, minify, validate, query." },
      path: { type: "string", description: "For action=query: a dotted path like 'user.roles.0'." },
    },
    ["json", "action"]
  ),
  run(args) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(str(args, "json"));
    } catch (err) {
      return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
    const action = str(args, "action").toLowerCase();
    if (action === "validate") return "Valid JSON.";
    if (action === "minify") return JSON.stringify(parsed);
    if (action === "query") {
      const path = str(args, "path");
      let cursor: unknown = parsed;
      for (const key of path.split(".").filter(Boolean)) {
        if (cursor === null || typeof cursor !== "object") return `Path "${path}" does not exist.`;
        cursor = (cursor as Record<string, unknown>)[key];
        if (cursor === undefined) return `Path "${path}" does not exist.`;
      }
      return JSON.stringify(cursor, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  },
};

const csvTool: ToolPluginSpec = {
  id: "tool-csv",
  name: "CSV tools",
  description: "Parse CSV into an aligned table or convert it to JSON.",
  tags: ["data", "csv", "spreadsheet"],
  def: obj(
    "csv_tool",
    "Parse CSV text and return it as an aligned table or as JSON records.",
    {
      csv: { type: "string", description: "The CSV text, first row treated as the header." },
      as: { type: "string", description: "'table' (default) or 'json'." },
    },
    ["csv"]
  ),
  run(args) {
    // Quote-aware split, so a comma inside "a,b" doesn't create a column.
    const parseLine = (line: string): string[] => {
      const cells: string[] = [];
      let cell = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
          else if (c === '"') quoted = false;
          else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ",") { cells.push(cell); cell = ""; }
        else cell += c;
      }
      cells.push(cell);
      return cells;
    };

    const lines = str(args, "csv").split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return "The CSV is empty.";
    const [header, ...rows] = lines.map(parseLine);

    if (str(args, "as").toLowerCase() === "json") {
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null]))),
        null,
        2
      );
    }
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
    return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line), `(${rows.length} rows)`].join("\n");
  },
};

// ---------------------------------------------------------------- encoding

const hashEncode: ToolPluginSpec = {
  id: "tool-hash",
  name: "Hash and encode",
  description: "SHA-256/384/512 hashes, plus base64 and hex encoding and decoding.",
  tags: ["developer", "encoding", "security"],
  def: obj(
    "hash_encode",
    "Hash text (SHA-256/384/512) or encode/decode it as base64 or hex. Exact, unlike guessing at a digest.",
    {
      text: { type: "string" },
      operation: {
        type: "string",
        description: "sha256 | sha384 | sha512 | base64-encode | base64-decode | hex-encode | hex-decode",
      },
    },
    ["text", "operation"]
  ),
  async run(args) {
    const text = typeof args.text === "string" ? args.text : "";
    const op = str(args, "operation").toLowerCase();
    const bytes = new TextEncoder().encode(text);

    if (op.startsWith("sha")) {
      const algo = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[op];
      if (!algo) return `Unknown hash "${op}".`;
      const digest = await crypto.subtle.digest(algo, bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (op === "base64-encode") return btoa(String.fromCharCode(...bytes));
    if (op === "base64-decode") return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    if (op === "hex-encode") return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (op === "hex-decode") {
      const pairs = text.replace(/\s+/g, "").match(/../g) ?? [];
      return new TextDecoder().decode(Uint8Array.from(pairs, (p) => parseInt(p, 16)));
    }
    return `Unknown operation "${op}".`;
  },
};

const uuidTool: ToolPluginSpec = {
  id: "tool-uuid",
  name: "ID generator",
  description: "Generate cryptographically random UUIDs and short ids.",
  tags: ["developer", "identifiers"],
  def: obj(
    "generate_id",
    "Generate one or more random identifiers. Never invent an identifier by hand - use this.",
    {
      kind: { type: "string", description: "'uuid' (default) or 'short'." },
      count: { type: "number", description: "How many to generate, up to 50." },
    },
    []
  ),
  run(args) {
    const count = Math.max(1, Math.min(50, Number(args.count) || 1));
    const short = str(args, "kind").toLowerCase() === "short";
    return Array.from({ length: count }, () => {
      const bytes = crypto.getRandomValues(new Uint8Array(short ? 8 : 16));
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (short) return hex;
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    }).join("\n");
  },
};

const jwtDecode: ToolPluginSpec = {
  id: "tool-jwt",
  name: "JWT decoder",
  description: "Decode a JWT's header and payload. Does not verify the signature.",
  tags: ["developer", "security", "auth"],
  def: obj(
    "jwt_decode",
    "Decode a JSON Web Token's header and payload for inspection. This does NOT verify the signature.",
    { token: { type: "string", description: "The JWT." } },
    ["token"]
  ),
  run(args) {
    const parts = str(args, "token").split(".");
    if (parts.length < 2) return "That does not look like a JWT (expected at least two dot-separated parts).";
    const decode = (part: string) => {
      const json = new TextDecoder().decode(
        Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
      );
      return JSON.stringify(JSON.parse(json), null, 2);
    };
    try {
      const payload = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
        )
      ) as { exp?: number };
      const expiry =
        typeof payload.exp === "number"
          ? `\n\nexpires: ${new Date(payload.exp * 1000).toISOString()} (${payload.exp * 1000 < Date.now() ? "EXPIRED" : "valid"})`
          : "";
      return `header:\n${decode(parts[0])}\n\npayload:\n${decode(parts[1])}${expiry}\n\nSignature not verified.`;
    } catch (err) {
      return `Could not decode: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ---------------------------------------------------------------- units and time

const colorTool: ToolPluginSpec = {
  id: "tool-color",
  name: "Colour tools",
  description: "Convert between hex, RGB and HSL, and check WCAG contrast between two colours.",
  tags: ["design", "accessibility", "color"],
  def: obj(
    "color_tool",
    "Convert a colour between hex/RGB/HSL, or compute the WCAG contrast ratio between two colours.",
    {
      color: { type: "string", description: "A hex colour like #1c1c1c." },
      against: { type: "string", description: "Optional second hex colour; returns the contrast ratio." },
    },
    ["color"]
  ),
  run(args) {
    const parse = (hex: string): [number, number, number] | null => {
      const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
      if (!m) return null;
      const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const rgb = parse(str(args, "color"));
    if (!rgb) return "Provide a hex colour like #1c1c1c.";

    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    const against = str(args, "against") ? parse(str(args, "against")) : null;
    if (against) {
      const [hi, lo] = [lum(rgb), lum(against)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      return [
        `contrast: ${ratio.toFixed(2)}:1`,
        `normal text AA (4.5:1): ${ratio >= 4.5 ? "pass" : "FAIL"}`,
        `large text AA (3:1): ${ratio >= 3 ? "pass" : "FAIL"}`,
        `normal text AAA (7:1): ${ratio >= 7 ? "pass" : "FAIL"}`,
      ].join("\n");
    }

    const [r, g, b] = rgb;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
      const [rr, gg, bb] = [r / 255, g / 255, b / 255];
      h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    return [
      `hex: #${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
      `rgb: rgb(${r}, ${g}, ${b})`,
      `hsl: hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
      `relative luminance: ${lum(rgb).toFixed(4)}`,
    ].join("\n");
  },
};

const dateTool: ToolPluginSpec = {
  id: "tool-datetime",
  name: "Date and time",
  description: "Convert timestamps, compute date differences and format dates in any timezone.",
  tags: ["time", "dates", "developer"],
  def: obj(
    "datetime_tool",
    "Parse a date, convert it between timezones and ISO/Unix form, or measure the difference between two dates. Do not do date arithmetic by hand.",
    {
      date: { type: "string", description: "An ISO date, a Unix timestamp, or 'now'." },
      until: { type: "string", description: "Optional second date; returns the difference." },
      timezone: { type: "string", description: "Optional IANA timezone, e.g. 'Europe/Vienna'." },
    },
    ["date"]
  ),
  run(args) {
    const parse = (value: string): Date | null => {
      if (!value || value.toLowerCase() === "now") return new Date();
      if (/^\d{9,13}$/.test(value)) return new Date(Number(value) * (value.length <= 10 ? 1000 : 1));
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = parse(str(args, "date"));
    if (!from) return `Could not parse "${str(args, "date")}".`;

    const until = str(args, "until") ? parse(str(args, "until")) : null;
    if (until) {
      const ms = Math.abs(until.getTime() - from.getTime());
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      const minutes = Math.floor((ms % 3_600_000) / 60_000);
      return `${days} days, ${hours} hours, ${minutes} minutes (${ms} ms total)`;
    }

    const tz = str(args, "timezone");
    const lines = [
      `ISO (UTC): ${from.toISOString()}`,
      `Unix seconds: ${Math.floor(from.getTime() / 1000)}`,
      `Unix ms: ${from.getTime()}`,
    ];
    if (tz) {
      try {
        lines.push(`In ${tz}: ${from.toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "long" })}`);
      } catch {
        lines.push(`Unknown timezone "${tz}".`);
      }
    }
    return lines.join("\n");
  },
};

const unitTool: ToolPluginSpec = {
  id: "tool-units",
  name: "Unit converter",
  description: "Convert between length, mass, temperature, data and time units.",
  tags: ["math", "units", "conversion"],
  def: obj(
    "convert_unit",
    "Convert a value between units (length, mass, temperature, data size, time). Use this rather than estimating a conversion.",
    {
      value: { type: "number" },
      from: { type: "string", description: "Source unit, e.g. 'km', 'lb', 'C', 'GiB', 'hour'." },
      to: { type: "string", description: "Target unit." },
    },
    ["value", "from", "to"]
  ),
  run(args) {
    const value = Number(args.value);
    if (!Number.isFinite(value)) return "Provide a numeric value.";
    const from = str(args, "from").toLowerCase();
    const to = str(args, "to").toLowerCase();

    // Everything but temperature converts through a base unit.
    const FACTORS: Record<string, [string, number]> = {
      mm: ["m", 0.001], cm: ["m", 0.01], m: ["m", 1], km: ["m", 1000],
      in: ["m", 0.0254], ft: ["m", 0.3048], yd: ["m", 0.9144], mi: ["m", 1609.344],
      mg: ["g", 0.001], g: ["g", 1], kg: ["g", 1000], oz: ["g", 28.349523125], lb: ["g", 453.59237],
      b: ["b", 1], kb: ["b", 1000], mb: ["b", 1e6], gb: ["b", 1e9], tb: ["b", 1e12],
      kib: ["b", 1024], mib: ["b", 1024 ** 2], gib: ["b", 1024 ** 3], tib: ["b", 1024 ** 4],
      ms: ["s", 0.001], s: ["s", 1], sec: ["s", 1], min: ["s", 60], hour: ["s", 3600],
      h: ["s", 3600], day: ["s", 86400], week: ["s", 604800],
    };

    const TEMP = new Set(["c", "f", "k", "celsius", "fahrenheit", "kelvin"]);
    if (TEMP.has(from) || TEMP.has(to)) {
      const norm = (u: string) => u[0];
      const toC = from[0] === "c" ? value : from[0] === "f" ? (value - 32) * (5 / 9) : value - 273.15;
      const out = norm(to) === "c" ? toC : norm(to) === "f" ? toC * (9 / 5) + 32 : toC + 273.15;
      return `${value} ${from} = ${Number(out.toFixed(4))} ${to}`;
    }

    const a = FACTORS[from];
    const b = FACTORS[to];
    if (!a || !b) return `Unknown unit. Known: ${Object.keys(FACTORS).join(", ")}, plus C/F/K.`;
    if (a[0] !== b[0]) return `Cannot convert ${from} (${a[0]}) to ${to} (${b[0]}) - different quantities.`;
    return `${value} ${from} = ${Number(((value * a[1]) / b[1]).toPrecision(10))} ${to}`;
  },
};

export const TOOL_PLUGINS: ToolPluginSpec[] = [
  regexTester,
  textStats,
  diffTool,
  jsonYaml,
  csvTool,
  hashEncode,
  uuidTool,
  jwtDecode,
  colorTool,
  dateTool,
  unitTool,
];
