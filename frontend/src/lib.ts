import type { AgentEvent, GuideTerm, Highlight, Rect, TraceStep, Turn } from "./types";

type TraceEvent = Extract<AgentEvent, { type: "step" | "step_done" }>;

export function applyTraceEvent(trace: TraceStep[], event: TraceEvent, now: number): TraceStep[] {
  if (event.type === "step") {
    const { type: _, ...step } = event;
    return [...trace, { ...step, status: "running", startedAt: now, reasoning: "" }];
  }
  const { type: _, ...result } = event;
  return trace.map((s) => (s.id === event.id ? { ...s, ...result, status: "done" } : s));
}

export function appendReasoning(trace: TraceStep[], stepId: string, text: string): TraceStep[] {
  return trace.map((s) => (s.id === stepId ? { ...s, reasoning: s.reasoning + text } : s));
}

/** Only the browser can tell whether a picture displays, so this arrives after the server's report. */
export function markRenderFailure(trace: TraceStep[], error: string): TraceStep[] {
  const drawn = trace.map((s) => s.agent === "illustrator" && s.outcome === "ok").lastIndexOf(true);
  return trace.map((s, i) => (i === drawn ? { ...s, outcome: "failed", render_error: error } : s));
}

export function interruptTrace(trace: TraceStep[]): TraceStep[] {
  return trace.map((s) => (s.status === "running" ? { ...s, status: "interrupted" } : s));
}

const RUNNING_WORDS: Record<TraceStep["agent"], string> = {
  coordinator: "Reading your highlight",
  librarian: "Searching the paper",
  tutor: "Writing an explanation",
  illustrator: "Drawing a picture",
  reviewer: "Checking against the paper",
  pathfinder: "Working out what to know first",
  examiner: "Writing a question",
  grader: "Grading your answer against the paper",
};

function joinWords(items: (string | number)[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One plain sentence on what a step did, or is doing. */
export function stepHeadline(step: TraceStep): string {
  if (step.status === "interrupted") return "Stopped when the page closed";
  if (step.status === "running") {
    if (step.repair_error) return "Fixing a picture that wouldn't display";
    if (step.rewrite) return step.agent === "tutor" ? "Rewriting after review" : "Redrawing after review";
    if (step.attempt > 1 && step.agent === "illustrator") return "Drawing it again";
    return RUNNING_WORDS[step.agent];
  }
  switch (step.agent) {
    case "coordinator": {
      if (step.outcome === "fallback") return "Couldn't make a plan, so used a general one";
      const kind = step.plan?.kind ?? "concept";
      return `Read your highlight as ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
    }
    case "librarian": {
      const passages = step.passages ?? [];
      if (!passages.length) return "Found no related passages";
      const pages = [...new Set(passages.map((p) => p.page))].sort((a, b) => a - b);
      return `Pulled ${passages.length} ${passages.length === 1 ? "passage" : "passages"} from ${pages.length === 1 ? "page" : "pages"} ${joinWords(pages)}`;
    }
    case "tutor":
      if (step.outcome === "failed") return step.rewrite ? "Couldn't rewrite it, so kept the first draft" : "Couldn't write an explanation";
      return step.rewrite ? "Rewrote the explanation after review" : "Wrote an explanation";
    case "illustrator":
      if (step.render_error) return step.repair_error ? "Tried a fix, but it still wouldn't display" : "Drew a picture that wouldn't display";
      if (step.syntax_error) return "Drew a diagram with a syntax error, so it goes back";
      if (step.outcome === "failed") return "Couldn't produce a picture on this try";
      if (step.repair_error) return "Fixed a picture that wouldn't display";
      if (step.rewrite) return "Redrew the picture after review";
      return step.form === "html" ? "Built an interactive picture" : "Drew a diagram";
    case "reviewer":
      if (step.outcome === "approved") return "Found no errors against the paper";
      if (step.outcome === "rejected") return step.will_rewrite ? "Found a problem and sent it back" : "Found a problem that's still there";
      return "Couldn't finish the check";
    case "pathfinder":
      if (step.outcome === "failed") return "Couldn't work out the order on this try";
      return step.study?.kind === "trail" ? `Laid out ${step.study.steps.length} ${step.study.steps.length === 1 ? "idea" : "ideas"} to know first` : "Laid out what to know first";
    case "examiner":
      return step.outcome === "failed" ? "Couldn't write a question on this try" : "Wrote a question";
    case "grader":
      return step.outcome === "failed" ? "Couldn't grade it on this try" : "Graded your answer against the paper";
  }
}

export function traceTotals(trace: TraceStep[]) {
  return {
    steps: trace.length,
    ms: trace.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0),
    tokens: trace.reduce((sum, s) => sum + (s.usage ? s.usage.input + s.usage.output : 0), 0),
  };
}

export function formatDuration(ms: number): string {
  if (ms < 100) return "under 0.1s";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatElapsed(ms: number): string {
  return ms < 60000 ? `${Math.floor(ms / 1000)}s` : formatDuration(ms);
}

/** Prompts repeat the paper's text and take the most room, so they go first when browser storage runs out. */
export function withoutPrompts(highlights: Highlight[]): Highlight[] {
  return highlights.map((h) => ({
    ...h,
    turns: h.turns.map((t) => ({ ...t, trace: t.trace.map(({ prompt: _, ...step }) => step) })),
  }));
}

/** Makes [p.4] and [p.4, p.7] citations clickable by rewriting them as links to #page-N. */
export function linkCitations(markdown: string): string {
  return markdown.replace(/\[((?:pp?\.\s*\d+(?:,\s*)?)+)\](?!\()/g, (_, list: string) =>
    [...list.matchAll(/\d+/g)].map(([n]) => `[p.${n}](#page-${n})`).join(", "),
  );
}

/** remark-math only understands dollar delimiters, and models often write \( \) and \[ \]. */
export function normalizeMath(markdown: string): string {
  return markdown
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$${body}$`);
}

const MAX_CITED = 8;

export interface CitationMatch { start: number; end: number; raw: string; numbers: number[] }

function citedNumbers(list: string): number[] | null {
  const numbers: number[] = [];
  for (const part of list.split(/[,;]/)) {
    const [low, high] = part.split(/[-\u2013\u2014]/).map((n) => Number(n.trim()));
    if (high === undefined) numbers.push(low);
    else if (high > low && high - low < MAX_CITED) for (let n = low; n <= high; n++) numbers.push(n);
    else return null;
  }
  return numbers.slice(0, MAX_CITED);
}

/** Finds citations like [12] and [1-4, 7]. Anything not in the reference list, like the interval [0, 1], isn't one. */
export function findCitations(text: string, known: number[]): CitationMatch[] {
  const matches: CitationMatch[] = [];
  for (const m of text.matchAll(/\[(\d{1,3}(?:\s*[,;\-\u2013\u2014]\s*\d{1,3})*)\]/g)) {
    const numbers = citedNumbers(m[1]);
    if (numbers?.length && numbers.every((n) => known.includes(n))) {
      matches.push({ start: m.index, end: m.index + m[0].length, raw: m[0], numbers });
    }
  }
  return matches;
}

export interface TermMatch { start: number; end: number; term: GuideTerm }

/** Finds glossary terms by the same rule the server uses, and the longest term wins where two overlap. */
export function findTerms(text: string, terms: GuideTerm[]): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const term of [...terms].sort((a, b) => b.term.length - a.term.length)) {
    const escaped = term.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = /[A-Z]/.test(term.term.slice(1)) ? "g" : "gi";
    for (const m of text.matchAll(new RegExp(`(?<![\\w-])${escaped}s?(?![\\w-])`, flags))) {
      const end = m.index + m[0].length;
      if (!matches.some((o) => m.index < o.end && o.start < end)) matches.push({ start: m.index, end, term });
    }
  }
  return matches;
}

/** Highlights in the order they appear in the paper. */
export function sortedHighlights(highlights: Highlight[]): Highlight[] {
  const top = (h: Highlight) => h.marks[0]?.rects[0]?.y ?? 0;
  return [...highlights].sort((a, b) => a.page - b.page || top(a) - top(b));
}

const VERDICT_WORDS = { correct: "Correct", partly: "Partly correct", not_yet: "Not yet correct" };

/** A turn as plain text, for the conversation sent back to the model and for exported notes. */
export function turnAsText(turn: Turn): string {
  const { study } = turn;
  if (study?.kind === "trail") {
    return study.steps
      .map((s, i) => `${i + 1}. ${s.idea} (${s.page ? `p.${s.page}` : "not covered in this paper"})${s.why ? `: ${s.why}` : ""}`)
      .join("\n");
  }
  if (study?.kind === "quiz") return `Question: ${study.question}`;
  if (study?.kind === "grade") {
    return [
      `Question: ${turn.question}`, `Your answer: ${turn.answer ?? ""}`, `Result: ${VERDICT_WORDS[study.verdict]}. ${study.feedback}`.trim(),
      study.correct_idea && `What the paper says: ${study.correct_idea}`,
      ...study.evidence.map((e) => `"${e.quote}" [p.${e.page}]`),
    ].filter(Boolean).join("\n\n");
  }
  if (turn.markdown) return turn.markdown;
  return turn.visual ? `Drew a picture: ${turn.visual.caption}` : "";
}

/** Every finished answer in reading order, as a Markdown document. */
export function notesMarkdown(paperName: string, highlights: Highlight[]): string {
  const parts = [`# Notes on ${paperName}`];
  for (const h of sortedHighlights(highlights)) {
    const turns = h.turns.filter((t) => t.status === "done");
    if (!turns.length) continue;
    parts.push(`## Page ${h.page}`, `> ${h.text}`);
    for (const t of turns) {
      parts.push(`### ${t.label}`);
      if (t.visual?.form === "mermaid") parts.push(`\`\`\`mermaid\n${t.visual.code}\n\`\`\``);
      if (t.visual?.form === "html") parts.push("(Interactive picture: open it in Margin.)");
      parts.push(turnAsText(t));
      if (t.check === "flagged") parts.push(`**Double-check this one.** The review found a possible problem: ${t.caveat}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

export function notesFilename(paperName: string): string {
  return `${paperName.replace(/\.pdf$/i, "")} notes.md`;
}

interface Box { left: number; top: number; width: number; height: number }

/** Turns a selection's client rects into tidy per-line rects, as fractions of the page. */
export function selectionRects(rects: Box[], page: Box): Rect[] {
  const visible = rects.filter((r) => r.width > 1 && r.height > 1);
  const heights = visible.map((r) => r.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const r of visible) {
    if (r.height > median * 3) continue; // The text layer's end-of-content element spans the page.
    const right = r.left + r.width;
    const bottom = r.top + r.height;
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, bottom) - Math.max(l.top, r.top);
      const gap = Math.max(r.left - l.right, l.left - right);
      return overlap > Math.min(l.bottom - l.top, r.height) / 2 && gap < r.height * 2;
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.top = Math.min(line.top, r.top);
      line.right = Math.max(line.right, right);
      line.bottom = Math.max(line.bottom, bottom);
    } else {
      lines.push({ left: r.left, top: r.top, right, bottom });
    }
  }
  return lines.map((l) => ({
    x: (l.left - page.left) / page.width,
    y: (l.top - page.top) / page.height,
    w: (l.right - l.left) / page.width,
    h: (l.bottom - l.top) / page.height,
  }));
}

export function hitTest(
  marks: { id: string; page: number; rects: Rect[] }[],
  page: number,
  x: number,
  y: number,
): string | null {
  for (const mark of marks) {
    if (mark.page !== page) continue;
    if (mark.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return mark.id;
  }
  return null;
}

export class SseParser {
  private buffer = "";

  feed(chunk: string): any[] {
    this.buffer += chunk;
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    return frames.filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)));
  }
}

const VISUAL_STYLE = `
:root { --ink:#1D1D1F; --muted:#6E6E73; --line:rgba(0,0,0,.12); --accent:#2F6F6B; --accent-soft:rgba(47,111,107,.14); --surface:#FFFFFF; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink:#F5F5F7; --muted:#A1A1A6; --line:rgba(255,255,255,.16); --accent:#7FC4B8; --accent-soft:rgba(127,196,184,.18); --surface:#2C2C2E; } }
html, body { margin:0; background:transparent; color:var(--ink); font:14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
body { padding:2px; overflow:hidden; }
svg, canvas { max-width:100%; }
input[type=range] { accent-color:var(--accent); width:100%; }
label { color:var(--muted); font-size:13px; }
`;

const VISUAL_BRIDGE = `
window.onerror = function (message) { parent.postMessage({ margin: "error", message: String(message) }, "*"); };
addEventListener("unhandledrejection", function (e) { parent.postMessage({ margin: "error", message: String(e.reason) }, "*"); });
addEventListener("DOMContentLoaded", function () {
  var report = function () { parent.postMessage({ margin: "height", height: document.documentElement.scrollHeight }, "*"); };
  new ResizeObserver(report).observe(document.body);
  report();
});
`;

/**
 * The document an interactive visual runs in. The model's code may be influenced by text in the paper,
 * so it runs in an opaque-origin sandbox (see VisualFrame) with this policy blocking all network access.
 */
export function visualDocument(code: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style>${VISUAL_STYLE}</style><script>${VISUAL_BRIDGE}</script></head><body>${code}</body></html>`;
}
