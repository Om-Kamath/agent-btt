import type { Rect } from "./types";

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
