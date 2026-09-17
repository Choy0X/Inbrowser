/**
 * Telling the model what this app can actually draw.
 *
 * Every one of these render paths already worked and none was ever advertised.
 * The only formatting sentence in DEFAULT_SYSTEM_PROMPT names "lists, headers,
 * code blocks" - so mermaid (about thirty diagram types, timelines and gantt
 * charts among them), KaTeX and GFM tables all rendered correctly and appeared
 * only when a model happened to guess they would.
 *
 * Two constraints shape the wording, both learned the hard way elsewhere in
 * this codebase:
 *
 * 1. **No literal template.** verify-prompt-scale.ts forbids placeholder
 *    scaffolding in the artifact contract because a 1B model asked "hi" replied
 *    with the contract's own template - a small model handed a concrete example
 *    reproduces the example. So the chart spec is described by naming its keys,
 *    never by showing a skeleton to copy.
 * 2. **It is not free.** This competes for the same context window the artifact
 *    contract does, so it is a separate constant with its own budget rather
 *    than more text bolted onto that one, and it is not sent to models running
 *    the compact prompt.
 *
 * Kept deliberately short: this is a list of what exists plus one rule about
 * when to reach for it, not a tutorial.
 */
export const RICH_OUTPUT_SYSTEM_PROMPT = [
  "This chat renders more than plain text. A mermaid code fence becomes a diagram - flowchart, sequence, state, class, entity-relationship, gantt, timeline, journey, mindmap, sankey, quadrant or treemap. Dollar-delimited LaTeX becomes typeset maths. Markdown tables render as sortable tables.",
  "A chart code fence becomes a real chart from data. Its body is a JSON object with type (bar, line, area, pie or scatter), an optional title, and either a data array of row objects naming x and y keys, or labels plus series. Optional: stacked, horizontal, xLabel, yLabel.",
  "One vertical scale per chart: never plot two different units together, use two charts. Keep a pie between three and six slices and use a bar chart otherwise.",
  "Reach for these when the shape of the answer is genuinely visual or comparative. Ordinary prose questions deserve ordinary prose.",
].join("\n");
