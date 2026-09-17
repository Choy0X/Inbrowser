import { useEffect, useMemo, useRef, useState } from "react";
import type { Chart, ChartConfiguration } from "chart.js";
import { BarChart3, Check, Copy, Download, Table2 } from "lucide-react";
import { chartToCsv, parseChartSpec, type ChartSpec } from "../lib/charts/chartSpec";
import { downloadText } from "../lib/artifactDownload";
import { useIsDarkTheme } from "../lib/useIsDarkTheme";
import { Tooltip } from "./Tooltip";

/**
 * A ```chart fenced block, drawn with Chart.js.
 *
 * Loaded lazily, like mermaid and KaTeX before it: a chat that never shows a
 * chart never downloads one. Chart.js is reached only through this import(),
 * so Rollup already emits it as its own async chunk and it needs no
 * manualChunks entry (see the comment on that config for which libraries do).
 *
 * The rules this renderer follows come from the data-visualization method, and
 * the ones that are not obvious are commented where they apply. The structural
 * ones - no dual axis, series caps, pie limits - are enforced earlier, in
 * chartSpec.ts, so nothing here has to decide whether a chart is honest.
 */

let chartPromise: Promise<typeof import("chart.js")> | null = null;
function loadChartJs() {
  if (!chartPromise) {
    chartPromise = import("chart.js").then((mod) => {
      // registerables pulls every controller/scale/plugin. Registration is
      // idempotent and happens once per session behind this memo.
      mod.Chart.register(...mod.registerables);
      return mod;
    });
  }
  return chartPromise;
}

/** Reads a design token off the document, so the canvas matches the theme. */
function token(name: string, fallback = "0 0 0"): string {
  if (typeof document === "undefined") return `rgb(${fallback})`;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `rgb(${value || fallback})`;
}

function tokenAlpha(name: string, alpha: number, fallback = "0 0 0"): string {
  if (typeof document === "undefined") return `rgb(${fallback} / ${alpha})`;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `rgb(${value || fallback} / ${alpha})`;
}

const seriesColor = (slot: number) => token(`--chart-${slot}`);
const seriesColorAlpha = (slot: number, alpha: number) => tokenAlpha(`--chart-${slot}`, alpha);

function buildConfig(spec: ChartSpec, dark: boolean): ChartConfiguration {
  // Text always wears text tokens, never the series colour - a coloured mark
  // beside a label is what carries identity, not coloured text.
  const ink = token("--fg");
  const inkDim = token("--fg-dim");
  // Grid and axes stay recessive: they are scaffolding, not data.
  const grid = tokenAlpha("--border", dark ? 0.9 : 1);
  const surface = token("--canvas", dark ? "1 1 32" : "255 255 255");

  const isPie = spec.type === "pie";
  const isArea = spec.type === "area";
  const isLine = spec.type === "line" || isArea;
  const isScatter = spec.type === "scatter";

  const datasets = spec.series.map((s) => {
    const color = seriesColor(s.slot);
    if (isPie) {
      return {
        label: s.name,
        data: s.values.map((v) => v ?? 0),
        backgroundColor: spec.labels.map((_, i) => seriesColor(((i % 8) + 1) as number)),
        // A 2px surface-coloured ring separates adjacent slices so two similar
        // hues never blend into one shape.
        borderColor: surface,
        borderWidth: 2,
      };
    }
    if (isScatter) {
      return {
        label: s.name,
        data: s.values.map((v, i) => ({ x: Number(spec.labels[i]) || i, y: v })),
        backgroundColor: color,
        borderColor: surface,
        borderWidth: 1,
        pointRadius: 5,
        pointHoverRadius: 7,
      };
    }
    return {
      label: s.name,
      data: s.values,
      backgroundColor: isArea ? seriesColorAlpha(s.slot, 0.18) : color,
      borderColor: color,
      borderWidth: isLine ? 2 : 0,
      fill: isArea ? "origin" : false,
      tension: isLine ? 0.25 : 0,
      pointRadius: isLine ? 0 : undefined,
      pointHoverRadius: isLine ? 5 : undefined,
      // Rounded data-ends, anchored to the baseline so the bar still reads as
      // starting at zero.
      borderRadius: isLine ? 0 : 4,
      borderSkipped: false,
      // A surface-coloured gap between stacked segments, same reason as the pie ring.
      ...(spec.stacked ? { borderColor: surface, borderWidth: 2 } : {}),
    };
  });

  return {
    type: isArea ? "line" : isScatter ? "scatter" : (spec.type as "bar" | "line" | "pie"),
    data: { labels: isScatter ? undefined : spec.labels, datasets: datasets as never },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: spec.horizontal ? "y" : "x",
      interaction: { mode: isLine ? "index" : "nearest", intersect: !isLine },
      plugins: {
        // A legend for 2+ series; a single series is named by the title or the
        // axis, so a one-row legend would just be noise.
        legend: {
          display: spec.series.length > 1 || isPie,
          position: "bottom",
          labels: { color: inkDim, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 },
        },
        tooltip: {
          backgroundColor: token("--night", "1 1 32"),
          titleColor: token("--on-night", "255 255 255"),
          bodyColor: token("--on-night-soft", "190 190 210"),
          borderColor: tokenAlpha("--on-night", 0.15, "255 255 255"),
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
        },
      },
      scales: isPie
        ? undefined
        : {
            x: {
              stacked: spec.stacked,
              title: spec.xLabel ? { display: true, text: spec.xLabel, color: inkDim } : undefined,
              ticks: { color: inkDim, maxRotation: 0, autoSkipPadding: 12 },
              grid: { display: false },
              border: { color: grid },
            },
            y: {
              stacked: spec.stacked,
              // Bars are read by length, so a truncated baseline exaggerates
              // every difference. Lines are read by shape and may be zoomed.
              beginAtZero: spec.type === "bar",
              title: spec.yLabel ? { display: true, text: spec.yLabel, color: inkDim } : undefined,
              ticks: { color: inkDim },
              grid: { color: grid, drawTicks: false },
              border: { display: false },
            },
          },
      // Colour identity has to survive the whole animation, and a chart that
      // grows on every re-render is distracting in a transcript.
      animation: { duration: 220 },
      layout: { padding: { top: 4 } },
      color: ink,
    },
  } as ChartConfiguration;
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky top-0 border border-border-subtle bg-bg-subtle px-3 py-1.5 text-left font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-fg-dim">
              {spec.xLabel ?? ""}
            </th>
            {spec.series.map((s) => (
              <th
                key={s.name}
                className="sticky top-0 border border-border-subtle bg-bg-subtle px-3 py-1.5 text-right font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-fg-dim"
              >
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.labels.map((label, i) => (
            <tr key={`${label}-${i}`}>
              <td className="border border-border-subtle px-3 py-1.5 text-left">{label}</td>
              {spec.series.map((s) => (
                <td
                  key={s.name}
                  className="border border-border-subtle px-3 py-1.5 text-right tabular-nums"
                >
                  {s.values[i] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartBlock({ code, streaming }: { code: string; streaming?: boolean }) {
  const parsed = useMemo(() => parseChartSpec(code), [code]);
  const dark = useIsDarkTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const spec = parsed.ok ? parsed.spec : null;
  const live = !streaming && spec !== null && view === "chart" && !failed;

  useEffect(() => {
    if (!live || !spec) return;
    let cancelled = false;
    void loadChartJs()
      .then((mod) => {
        if (cancelled || !canvasRef.current) return;
        chartRef.current?.destroy();
        chartRef.current = new mod.Chart(canvasRef.current, buildConfig(spec, dark));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // `dark` is a dependency on purpose: the canvas holds painted pixels, not
    // styled elements, so a theme change has to rebuild it rather than restyle.
  }, [live, spec, dark]);

  // A chart that is still being typed cannot parse, and re-attempting per token
  // would flicker - so show the source, exactly as mermaid and KaTeX do.
  if (streaming || !spec) {
    return (
      <pre data-ui="code-block" className="code-block">
        <code>{code}</code>
      </pre>
    );
  }

  const csv = chartToCsv(spec);
  const filename = `${(spec.title ?? "chart").replace(/[^\w.-]+/g, "-").toLowerCase()}.csv`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard API unavailable (e.g. insecure context) — nothing to fall back to. */
    }
  };

  return (
    <div data-ui="chart-block" className="my-3 bg-bg-elevated">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 size={13} className="shrink-0 text-fg-faint" />
          <span className="truncate text-sm font-medium">{spec.title ?? "Chart"}</span>
          {spec.folded && (
            <Tooltip label="Series past the readable limit are summed into Other">
              <span className="shrink-0 rounded-md bg-amber/15 px-1.5 py-0.5 text-[10px] text-amber">
                Grouped
              </span>
            </Tooltip>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Always present, not a nicety: three light-mode series colours fall
            * under 3:1 against white, and the method's relief rule makes a
            * table view mandatory when they do. */}
          <Tooltip label={view === "chart" ? "Show the data" : "Show the chart"}>
            <button
              type="button"
              onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
              aria-label={view === "chart" ? "Show the data" : "Show the chart"}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg"
            >
              {view === "chart" ? <Table2 size={12} /> : <BarChart3 size={12} />}
              {view === "chart" ? "Table" : "Chart"}
            </button>
          </Tooltip>
          <Tooltip label={`Download ${filename}`}>
            <button
              type="button"
              onClick={() => downloadText(filename, csv)}
              aria-label={`Download ${filename}`}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg"
            >
              <Download size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Copy as CSV">
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy as CSV"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </Tooltip>
        </div>
      </div>

      {view === "table" ? (
        <ChartTable spec={spec} />
      ) : failed ? (
        <div className="px-3 py-6 text-center text-sm text-fg-dim">
          The chart renderer could not be loaded. Use Table to read the data.
        </div>
      ) : (
        <div className="h-64 p-3 sm:h-72">
          <canvas ref={canvasRef} role="img" aria-label={spec.title ?? "Chart"} />
        </div>
      )}
    </div>
  );
}
