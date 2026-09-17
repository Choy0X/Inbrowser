/**
 * The ```chart fence: a small JSON spec, parsed into something safe to draw.
 *
 * This file is where the data-visualization rules are enforced *structurally*
 * rather than left to whether a model happened to behave. A spec that would
 * produce a misleading chart is rejected or folded here, before any pixels
 * exist, so ChartBlock never has to decide anything.
 *
 * The three that matter most:
 *
 * - **No dual axis.** There is no `y2` in the schema and there never should be.
 *   Two y-scales on one plot is the single worst chart mistake: the alignment
 *   between the scales is arbitrary, so the picture invents a correlation the
 *   data does not contain. Two measures of different magnitude belong in two
 *   charts, or indexed to a common base on one axis.
 * - **Series caps, measured not guessed.** The palette in styles.css was run
 *   through the colour-blindness checker against this app's real surfaces.
 *   Forms where only neighbouring series touch (bar, line, area) are safe to
 *   slot 8. Scatter puts every pair on screen simultaneously, and there the
 *   4th slot lands yellow next to orange, which fails the all-pairs floor - so
 *   scatter stops at 3 and the rest folds into "Other".
 * - **Colour follows the entity.** Slots are assigned from the series *name*,
 *   never its array index, so a reader who learned "Revenue is blue" is not
 *   shown a repainted chart after a re-render.
 */

export const CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Slots available in styles.css (--chart-1 .. --chart-8). */
export const PALETTE_SLOTS = 8;

/**
 * Forms where every series is compared against every other at once, so the
 * palette's all-pairs limit applies instead of its adjacent-pairs limit.
 */
const ALL_PAIRS_TYPES = new Set<ChartType>(["scatter"]);
const ALL_PAIRS_CAP = 3;

/** Part-to-whole is readable at a glance only while the slices stay few. */
const PIE_MAX_SEGMENTS = 6;
/** A two-slice pie is a statistic, not a chart; one slice is a sentence. */
const PIE_MIN_SEGMENTS = 3;

/** Everything past the cap is summed into a single honest bucket. */
export const OTHER_LABEL = "Other";

export interface ChartSeries {
  name: string;
  /** One value per category, aligned with `labels`. null = a real gap. */
  values: (number | null)[];
  /** 1-based palette slot, assigned by name order of first appearance. */
  slot: number;
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  /** Axis captions. Never two y captions - see the dual-axis note above. */
  xLabel?: string;
  yLabel?: string;
  labels: string[];
  series: ChartSeries[];
  stacked: boolean;
  horizontal: boolean;
  /** True when a tail of series was folded into "Other" by the cap. */
  folded: boolean;
}

export type ChartParseResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts a real number or a numeric string; anything else is a gap, not a 0. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    // Tolerates the thousands separators and currency marks models emit.
    const cleaned = value.replace(/[,\s$%]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Folds the tail past `cap` into one summed "Other" series.
 *
 * Summing is only meaningful when the series share a unit, which is exactly the
 * case a single y-axis already guarantees. The alternative - inventing a 9th
 * colour - is what the palette order exists to prevent.
 */
function foldTail(series: ChartSeries[], cap: number): { series: ChartSeries[]; folded: boolean } {
  if (series.length <= cap) return { series, folded: false };
  const kept = series.slice(0, cap - 1);
  const tail = series.slice(cap - 1);
  const width = series[0]?.values.length ?? 0;
  const values: (number | null)[] = [];
  for (let i = 0; i < width; i++) {
    let sum: number | null = null;
    for (const s of tail) {
      const v = s.values[i];
      if (v !== null && v !== undefined) sum = (sum ?? 0) + v;
    }
    values.push(sum);
  }
  kept.push({ name: OTHER_LABEL, values, slot: cap });
  return { series: kept, folded: true };
}

/**
 * Parses the body of a ```chart fence.
 *
 * Two input shapes, because models reliably produce both:
 *   row form    - `data` is a list of objects, `x` names the label key, `y`
 *                 names one value key or `series` names several.
 *   series form - `labels` plus `series: [{ name, data: [...] }]`.
 *
 * Returns a result rather than throwing: an unparseable chart degrades to its
 * own source text, the same way a broken mermaid diagram or a half-written
 * formula does.
 */
export function parseChartSpec(source: string): ChartParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: "This chart block is not valid JSON." };
  }
  if (!isRecord(raw)) return { ok: false, error: "A chart spec must be a JSON object." };

  const type = str(raw.type)?.toLowerCase() as ChartType | undefined;
  if (!type || !(CHART_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `Unknown chart type. Use one of: ${CHART_TYPES.join(", ")}.` };
  }

  // Refused rather than silently flattened: a spec asking for a second y-axis
  // wanted a chart this renderer deliberately will not draw, and quietly
  // dropping the second measure would misrepresent it just as badly.
  if ("y2" in raw || "yRight" in raw || "secondaryAxis" in raw) {
    return {
      ok: false,
      error: "Two y-axes on one plot are not supported - the scales would imply a correlation that isn't in the data. Use two charts.",
    };
  }

  let labels: string[] = [];
  let series: { name: string; values: (number | null)[] }[] = [];

  if (Array.isArray(raw.labels) && Array.isArray(raw.series)) {
    labels = raw.labels.map((l) => String(l));
    series = raw.series.filter(isRecord).map((s, i) => ({
      name: str(s.name) ?? `Series ${i + 1}`,
      values: (Array.isArray(s.data) ? s.data : []).map(toNumber),
    }));
  } else if (Array.isArray(raw.data)) {
    const rows = raw.data.filter(isRecord);
    if (rows.length === 0) return { ok: false, error: "This chart has no data." };
    const keys = Object.keys(rows[0]);
    const xKey = str(raw.x) ?? keys[0];
    const yKeys = Array.isArray(raw.series)
      ? raw.series.map((s) => String(s))
      : str(raw.y)
        ? [str(raw.y)!]
        : keys.filter((k) => k !== xKey);
    if (yKeys.length === 0) return { ok: false, error: "This chart has no value column." };
    labels = rows.map((r) => String(r[xKey] ?? ""));
    series = yKeys.map((k) => ({ name: k, values: rows.map((r) => toNumber(r[k])) }));
  } else {
    return { ok: false, error: "A chart spec needs either `data` rows or `labels` plus `series`." };
  }

  series = series.filter((s) => s.values.some((v) => v !== null));
  if (series.length === 0 || labels.length === 0) return { ok: false, error: "This chart has no usable data." };

  if (type === "pie") {
    // Part-to-whole reads one whole, so extra series are not a thing a pie can
    // show. Anything beyond the first belongs in a bar chart.
    if (series.length > 1) {
      return { ok: false, error: "A pie shows one series. Use a bar chart to compare several." };
    }
    const segments = labels.length;
    if (segments < PIE_MIN_SEGMENTS) {
      return {
        ok: false,
        error: `A ${segments}-slice pie is a statistic, not a chart - state the number instead.`,
      };
    }
    if (segments > PIE_MAX_SEGMENTS) {
      return {
        ok: false,
        error: `A pie stops being readable past ${PIE_MAX_SEGMENTS} slices. Use a bar chart.`,
      };
    }
  }

  // Slot by first appearance of the NAME, so the same series keeps its colour
  // across re-renders and across charts in the same answer.
  const slots = new Map<string, number>();
  const withSlots: ChartSeries[] = series.map((s) => {
    let slot = slots.get(s.name);
    if (slot === undefined) {
      slot = Math.min(slots.size + 1, PALETTE_SLOTS);
      slots.set(s.name, slot);
    }
    return { ...s, slot };
  });

  const cap = ALL_PAIRS_TYPES.has(type) ? ALL_PAIRS_CAP : PALETTE_SLOTS;
  const { series: capped, folded } = foldTail(withSlots, cap);

  return {
    ok: true,
    spec: {
      type,
      title: str(raw.title),
      xLabel: str(raw.xLabel) ?? str(raw.x),
      yLabel: str(raw.yLabel) ?? (capped.length === 1 ? capped[0].name : undefined),
      labels,
      series: capped,
      stacked: raw.stacked === true,
      horizontal: raw.horizontal === true,
      folded,
    },
  };
}

/** The chart's data as CSV - the download, and the table view's source. */
export function chartToCsv(spec: ChartSpec): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = [spec.xLabel ?? "", ...spec.series.map((s) => s.name)].map(escape).join(",");
  const rows = spec.labels.map((label, i) =>
    [label, ...spec.series.map((s) => (s.values[i] ?? "").toString())].map(escape).join(",")
  );
  return [header, ...rows].join("\n");
}
