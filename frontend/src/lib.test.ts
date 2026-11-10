import { describe, expect, it } from "vitest";
import {
  appendReasoning,
  applyTraceEvent,
  findCitations,
  findTerms,
  formatDuration,
  formatElapsed,
  hitTest,
  interruptTrace,
  linkCitations,
  markRenderFailure,
  normalizeMath,
  notesFilename,
  notesMarkdown,
  selectionRects,
  sortedHighlights,
  SseParser,
  stepHeadline,
  traceTotals,
  turnAsText,
  visualDocument,
  withoutPrompts,
} from "./lib";
import type { Highlight, TraceStep, Turn } from "./types";

const page = { left: 100, top: 200, width: 1000, height: 2000 };

describe("linkCitations", () => {
  it("turns a page citation into a jump link", () => {
    expect(linkCitations("True [p.4].")).toBe("True [p.4](#page-4).");
  });
  it("splits a citation naming several pages", () => {
    expect(linkCitations("True [p.4, p.7].")).toBe("True [p.4](#page-4), [p.7](#page-7).");
  });
  it("leaves existing links alone", () => {
    expect(linkCitations("[p.4](#page-4)")).toBe("[p.4](#page-4)");
  });
});

describe("normalizeMath", () => {
  it("converts bracket delimiters to dollars", () => {
    expect(normalizeMath("So \\(x^2\\) and \\[y\\].")).toBe("So $x^2$ and $$y$$.");
  });
});

describe("selectionRects", () => {
  it("converts to fractions of the page", () => {
    const [r] = selectionRects([{ left: 200, top: 400, width: 500, height: 20 }], page);
    expect(r).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.01 });
  });
  it("merges adjacent spans on a line into one rect", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 300, top: 402, width: 100, height: 16 },
      ],
      page,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0].w).toBeCloseTo(0.2);
  });
  it("keeps separate lines separate", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 200, top: 430, width: 100, height: 20 },
      ],
      page,
    );
    expect(rects).toHaveLength(2);
  });
  it("drops empty rects and the page-tall rect the text layer can produce", () => {
    const rects = selectionRects(
      [
        { left: 200, top: 400, width: 100, height: 20 },
        { left: 200, top: 430, width: 100, height: 20 },
        { left: 200, top: 460, width: 0, height: 20 },
        { left: 100, top: 200, width: 1000, height: 1800 },
      ],
      page,
    );
    expect(rects).toHaveLength(2);
  });
});

describe("hitTest", () => {
  const marks = [{ id: "a", page: 2, rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.01 }] }];
  it("finds the highlight under a point on its page", () => {
    expect(hitTest(marks, 2, 0.2, 0.105)).toBe("a");
  });
  it("misses on another page or elsewhere on the page", () => {
    expect(hitTest(marks, 1, 0.2, 0.105)).toBeNull();
    expect(hitTest(marks, 2, 0.9, 0.105)).toBeNull();
  });
});

describe("SseParser", () => {
  it("parses events split across network chunks", () => {
    const parser = new SseParser();
    expect(parser.feed('data: {"type":"tok')).toEqual([]);
    expect(parser.feed('en"}\n\ndata: {"type":"done"}\n\n')).toEqual([{ type: "token" }, { type: "done" }]);
  });
});

describe("visualDocument", () => {
  const doc = visualDocument("<script>draw()</script>");
  it("puts a no-network content security policy before the model's code", () => {
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(-1);
    expect(doc).toContain("default-src 'none'");
    expect(policy).toBeLessThan(doc.indexOf("draw()"));
  });
  it("installs error reporting before the model's code", () => {
    expect(doc.indexOf("window.onerror")).toBeLessThan(doc.indexOf("draw()"));
  });
  it("defines the colours the illustrator is told to use", () => {
    for (const name of ["--ink", "--muted", "--line", "--accent", "--accent-soft", "--surface"]) {
      expect(doc).toContain(`${name}:`);
    }
  });
});

describe("the step trace", () => {
  const start = (id: string, agent: TraceStep["agent"], extra = {}) =>
    ({ type: "step", id, agent, attempt: 1, ...extra }) as const;
  const finished = (agent: TraceStep["agent"], details: Partial<TraceStep>): TraceStep => ({
    id: "s", agent, attempt: 1, status: "done", startedAt: 0, reasoning: "", outcome: "ok", duration_ms: 1000, ...details,
  });

  it("builds steps from events in order", () => {
    let trace = applyTraceEvent([], start("a", "coordinator"), 5);
    trace = applyTraceEvent(trace, { type: "step_done", id: "a", outcome: "ok", duration_ms: 40 }, 6);
    trace = applyTraceEvent(trace, start("b", "librarian"), 7);
    expect(trace.map((s) => [s.id, s.status, s.duration_ms])).toEqual([["a", "done", 40], ["b", "running", undefined]]);
    expect(trace[1].startedAt).toBe(7);
  });

  it("appends reasoning to the step it belongs to", () => {
    let trace = applyTraceEvent([], start("a", "coordinator"), 0);
    trace = applyTraceEvent(trace, start("b", "reviewer"), 0);
    trace = appendReasoning(trace, "a", "one ");
    trace = appendReasoning(trace, "a", "two");
    expect(trace[0].reasoning).toBe("one two");
    expect(trace[1].reasoning).toBe("");
  });

  it("keeps reasoning when a step finishes", () => {
    let trace = applyTraceEvent([], start("a", "reviewer"), 0);
    trace = appendReasoning(trace, "a", "checked");
    trace = applyTraceEvent(trace, { type: "step_done", id: "a", outcome: "approved" }, 0);
    expect(trace[0].reasoning).toBe("checked");
  });

  it("marks running steps as interrupted after a reload", () => {
    const trace = [finished("coordinator", {}), { ...finished("tutor", {}), status: "running" as const }];
    expect(interruptTrace(trace).map((s) => s.status)).toEqual(["done", "interrupted"]);
  });

  it.each([
    [finished("coordinator", { plan: { kind: "equation" } }), "Read your highlight as an equation"],
    [finished("coordinator", { outcome: "fallback" }), "Couldn't make a plan, so used a general one"],
    [finished("librarian", { passages: [{ page: 2, text: "", source: "highlight", score: null }, { page: 7, text: "", source: "search", score: 1 }, { page: 2, text: "", source: "search", score: 1 }] }), "Pulled 3 passages from pages 2 and 7"],
    [finished("librarian", { passages: [] }), "Found no related passages"],
    [finished("tutor", {}), "Wrote an explanation"],
    [finished("tutor", { rewrite: true }), "Rewrote the explanation after review"],
    [finished("tutor", { outcome: "failed" }), "Couldn't write an explanation"],
    [finished("illustrator", { form: "mermaid" }), "Drew a diagram"],
    [finished("illustrator", { form: "html" }), "Built an interactive picture"],
    [finished("illustrator", { form: "html", repair_error: "x" }), "Fixed a picture that wouldn't display"],
    [finished("reviewer", { outcome: "approved" }), "Found no errors against the paper"],
    [finished("reviewer", { outcome: "rejected", will_rewrite: true }), "Found a problem and sent it back"],
    [finished("reviewer", { outcome: "rejected", will_rewrite: false }), "Found a problem that's still there"],
    [finished("reviewer", { outcome: "failed" }), "Couldn't finish the check"],
    [finished("tutor", { status: "interrupted", outcome: undefined }), "Stopped when the page closed"],
  ])("describes a step in plain words", (step, words) => {
    expect(stepHeadline(step)).toBe(words);
  });

  it("describes running steps as ongoing", () => {
    expect(stepHeadline({ ...finished("reviewer", {}), status: "running", outcome: undefined })).toBe("Checking against the paper");
    expect(stepHeadline({ ...finished("illustrator", {}), status: "running", outcome: undefined, rewrite: true })).toBe("Redrawing after review");
  });

  it("sums time and tokens", () => {
    const trace = [finished("coordinator", { duration_ms: 1500, usage: { input: 10, output: 2 } }), finished("librarian", { duration_ms: 500 })];
    expect(traceTotals(trace)).toEqual({ steps: 2, ms: 2000, tokens: 12 });
  });

  it("formats durations", () => {
    expect(formatDuration(40)).toBe("under 0.1s");
    expect(formatDuration(1540)).toBe("1.5s");
    expect(formatDuration(87200)).toBe("1m 27s");
  });

  it("can drop the bulkiest fields to fit browser storage, keeping the decisions", () => {
    const highlights = [{ id: "h", text: "t", page: 1, marks: [], turns: [{ trace: [finished("reviewer", { prompt: { system: "s", user: "u" }, output: "o", code: "c", reasoning: "r", issues: "kept" })] }] }] as unknown as Highlight[];
    const [step] = withoutPrompts(highlights)[0].turns[0].trace;
    expect(step.prompt).toBeUndefined();
    expect(step.issues).toBe("kept");
    expect(step.output).toBe("o");
  });
});

describe("the clock on a running step", () => {
  it("counts whole seconds", () => {
    expect(formatElapsed(400)).toBe("0s");
    expect(formatElapsed(12900)).toBe("12s");
    expect(formatElapsed(87200)).toBe("1m 27s");
  });
});

describe("a picture the browser can't display", () => {
  const step = (id: string, agent: TraceStep["agent"], extra: Partial<TraceStep> = {}): TraceStep => ({
    id, agent, attempt: 1, status: "done", startedAt: 0, reasoning: "", outcome: "ok", ...extra,
  });

  it("goes on the record against the step that drew it, not a later one", () => {
    const trace = [step("a", "illustrator", { form: "mermaid" }), step("b", "reviewer", { outcome: "approved" })];
    const [drew, reviewed] = markRenderFailure(trace, "Parse error");
    expect(drew.outcome).toBe("failed");
    expect(drew.render_error).toBe("Parse error");
    expect(reviewed.outcome).toBe("approved");
  });

  it("says when the server's syntax check sent a diagram back", () => {
    expect(stepHeadline(step("a", "illustrator", { outcome: "failed", syntax_error: "Parse error" }))).toBe("Drew a diagram with a syntax error, so it goes back");
  });

  it("isn't described as drawn or fixed", () => {
    const failed = { outcome: "failed" as const, render_error: "Parse error" };
    expect(stepHeadline(step("a", "illustrator", { form: "mermaid", ...failed }))).toBe("Drew a picture that wouldn't display");
    expect(stepHeadline(step("a", "illustrator", { repair_error: "x", ...failed }))).toBe("Tried a fix, but it still wouldn't display");
  });
});

describe("findCitations", () => {
  const known = [1, 2, 3, 4, 7, 12];
  it("finds a single citation", () => {
    expect(findCitations("as shown in [12].", known)).toEqual([{ start: 12, end: 16, raw: "[12]", numbers: [12] }]);
  });
  it("expands ranges and lists", () => {
    expect(findCitations("[1–4, 7]", known)[0].numbers).toEqual([1, 2, 3, 4, 7]);
    expect(findCitations("[1-3]", known)[0].numbers).toEqual([1, 2, 3]);
  });
  it("ignores brackets that aren't in the reference list", () => {
    expect(findCitations("in the interval [0, 1]", known)).toEqual([]);
    expect(findCitations("[99]", known)).toEqual([]);
    expect(findCitations("[1-3000]", known)).toEqual([]);
  });
  it("finds nothing in a paper without numbered references", () => {
    expect(findCitations("see [1]", [])).toEqual([]);
  });
});

describe("findTerms", () => {
  const term = (name: string) => ({ term: name, definition: "d", first_page: 1 });
  it("matches plurals and ignores case for ordinary words", () => {
    expect(findTerms("Composite health scores rise", [term("composite health score")])[0]).toMatchObject({ start: 0, end: 23 });
  });
  it("keeps the case of abbreviations", () => {
    expect(findTerms("the CHS value", [term("CHS")])).toHaveLength(1);
    expect(findTerms("the chs value", [term("CHS")])).toHaveLength(0);
  });
  it("doesn't match inside a longer word", () => {
    expect(findTerms("a partial result", [term("art")])).toEqual([]);
  });
  it("prefers the longest term where two overlap", () => {
    const found = findTerms("self attention layer", [term("attention"), term("self attention")]);
    expect(found).toHaveLength(1);
    expect(found[0].term.term).toBe("self attention");
  });
  it("copes with terms containing regex characters", () => {
    expect(findTerms("uses C++ here", [term("C++")])).toHaveLength(1);
    expect(findTerms("uses k(x) here", [term("k(x)")])).toHaveLength(1);
  });
});

describe("notes", () => {
  const turn = (over: Partial<Turn>): Turn => ({
    id: "t", intent: "explain", label: "Explain", question: "", status: "done", trace: [], markdown: "", visual: null,
    sources: [], check: "passed", caveat: "", error: "", repairs: 0, ...over,
  });
  const highlight = (page: number, y: number, turns: Turn[]): Highlight => ({ id: `${page}-${y}`, text: `Text on ${page}`, page, marks: [{ page, rects: [{ x: 0, y, w: 1, h: 1 }] }], turns });

  it("orders highlights as they appear in the paper", () => {
    const list = [highlight(3, 0.1, []), highlight(1, 0.9, []), highlight(1, 0.2, [])];
    expect(sortedHighlights(list).map((h) => h.id)).toEqual(["1-0.2", "1-0.9", "3-0.1"]);
  });
  it("writes each kind of answer as text", () => {
    expect(turnAsText(turn({ markdown: "Plain answer" }))).toBe("Plain answer");
    expect(turnAsText(turn({ visual: { form: "mermaid", code: "x", caption: "A map" } }))).toBe("Drew a picture: A map");
    expect(turnAsText(turn({ study: { kind: "quiz", question: "Why?" } }))).toBe("Question: Why?");
    expect(turnAsText(turn({ study: { kind: "trail", steps: [{ idea: "A", why: "Needed", page: 2 }, { idea: "B", why: "", page: null }] } })))
      .toBe("1. A (p.2): Needed\n2. B (not covered in this paper)");
    const graded = turnAsText(turn({ question: "Why?", answer: "Because", study: { kind: "grade", verdict: "partly", feedback: "Close.", correct_idea: "It scales.", evidence: [{ page: 2, quote: "scales" }] } }));
    expect(graded).toContain("Your answer: Because");
    expect(graded).toContain("Result: Partly correct. Close.");
    expect(graded).toContain('"scales" [p.2]');
  });
  it("exports finished answers only, and keeps warnings", () => {
    const notes = notesMarkdown("paper.pdf", [
      highlight(2, 0, [turn({ markdown: "Later page" })]),
      highlight(1, 0, [
        turn({ label: "Explain", markdown: "First", check: "flagged", caveat: "Check the sign." }),
        turn({ label: "Failed", status: "error", markdown: "Partial" }),
      ]),
      highlight(5, 0, [turn({ status: "error" })]),
    ]);
    expect(notes.startsWith("# Notes on paper.pdf")).toBe(true);
    expect(notes.indexOf("## Page 1")).toBeLessThan(notes.indexOf("## Page 2"));
    expect(notes).toContain("Check the sign.");
    expect(notes).not.toContain("Partial");
    expect(notes).not.toContain("## Page 5");
  });
  it("keeps diagrams as code and says where interactive pictures are", () => {
    const notes = notesMarkdown("p", [highlight(1, 0, [
      turn({ visual: { form: "mermaid", code: "flowchart LR", caption: "Flow" } }),
      turn({ visual: { form: "html", code: "<svg/>", caption: "Slider" } }),
    ])]);
    expect(notes).toContain("```mermaid\nflowchart LR\n```");
    expect(notes).toContain("Interactive picture");
    expect(notes).not.toContain("<svg/>");
  });
  it("names the file after the paper", () => {
    expect(notesFilename("Attention.PDF")).toBe("Attention notes.md");
  });
});

describe("study step headlines", () => {
  const done = (over: Partial<TraceStep>): TraceStep => ({ id: "s", agent: "grader", attempt: 1, status: "done", startedAt: 0, reasoning: "", outcome: "ok", ...over });
  it("describes each study agent", () => {
    expect(stepHeadline(done({ agent: "pathfinder", study: { kind: "trail", steps: [{ idea: "A", why: "", page: 1 }] } }))).toBe("Laid out 1 idea to know first");
    expect(stepHeadline(done({ agent: "examiner" }))).toBe("Wrote a question");
    expect(stepHeadline(done({ agent: "grader" }))).toBe("Graded your answer against the paper");
    expect(stepHeadline(done({ agent: "grader", outcome: "failed" }))).toBe("Couldn't grade it on this try");
  });
});
