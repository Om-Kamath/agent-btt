import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask, getCitation, getGuide, getHealth, getPaper, paperFileUrl, uploadPaper } from "./api";
import type { AskBody, Health } from "./api";
import { PdfReader } from "./PdfReader";
import type { CitationClick, ReaderHandle, SelectionInfo, TextAnchor } from "./PdfReader";
import { NotesPrint } from "./NotesPrint";
import { CitationCard, TermTip } from "./Popovers";
import { Sheet } from "./Sheet";
import { Side } from "./Side";
import type { SideTab } from "./Side";
import { appendReasoning, applyTraceEvent, interruptTrace, markRenderFailure, notesFilename, notesMarkdown, turnAsText, withoutPrompts } from "./lib";
import type { CitationResult, Guide, GuideTerm, Highlight, Intent, Paper, Turn } from "./types";

const LAST_PAPER = "margin.lastPaper";
const HIDE_MARKS = "margin.hideMarks";
const highlightsKey = (paperId: string) => `margin.highlights.${paperId}`;
const guideSeenKey = (paperId: string) => `margin.guideSeen.${paperId}`;
const TERM_SHOW_MS = 300;
const TERM_HIDE_MS = 220;
const TOKEN_FLUSH_MS = 70;
const SAVE_WHILE_WORKING_MS = 800;

function loadHighlights(paperId: string): Highlight[] {
  try {
    const saved: Highlight[] = JSON.parse(localStorage.getItem(highlightsKey(paperId)) ?? "[]");
    return saved.map((h) => ({
      ...h,
      turns: h.turns.map((t) => {
        const trace = interruptTrace(t.trace ?? []); // Answers saved by older versions have no trace.
        return t.status === "working"
          ? { ...t, trace, status: "error" as const, error: "This answer was interrupted when the page closed." }
          : { ...t, trace };
      }),
    }));
  } catch {
    return [];
  }
}

function newTurn(intent: Intent, label: string, question = "", answer = ""): Turn {
  return {
    id: crypto.randomUUID(), intent, label, question, answer, status: "working", trace: [], markdown: "", visual: null,
    sources: [], check: "skipped", caveat: "", error: "", repairs: 0,
  };
}

function historyBefore(highlight: Highlight, turnId: string): AskBody["history"] {
  const history: NonNullable<AskBody["history"]> = [];
  for (const turn of highlight.turns) {
    if (turn.id === turnId) break;
    if (turn.status !== "done") continue;
    history.push({ role: "user", content: turn.label });
    history.push({ role: "assistant", content: turnAsText(turn) });
  }
  return history;
}

export function App() {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [side, setSide] = useState<SideTab | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [guideError, setGuideError] = useState("");
  const [guideTry, setGuideTry] = useState(0);
  const [hideMarks, setHideMarks] = useState(() => localStorage.getItem(HIDE_MARKS) === "true");
  const [printing, setPrinting] = useState(false);
  const [tip, setTip] = useState<{ term: GuideTerm; anchor: TextAnchor } | null>(null);
  const [citation, setCitation] = useState<{ click: CitationClick; result: CitationResult | null; error: string } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const citations = useRef(new Map<string, CitationResult>());

  const reader = useRef<ReaderHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const streams = useRef(new Map<string, AbortController>());
  const lastActive = useRef<string | null>(null);
  if (activeId) lastActive.current = activeId;

  const showPaper = useCallback((next: Paper) => {
    streams.current.forEach((c) => c.abort());
    streams.current.clear();
    setHighlights(loadHighlights(next.id));
    setActiveId(null);
    setSelection(null);
    setPage(1);
    setPaper(next);
    setGuide(null);
    setGuideError("");
    setTip(null);
    setCitation(null);
    citations.current.clear();
    // The guide opens by itself once, the first time a paper is seen.
    setSide(localStorage.getItem(guideSeenKey(next.id)) ? null : "guide");
    localStorage.setItem(guideSeenKey(next.id), "true");
    localStorage.setItem(LAST_PAPER, next.id);
  }, []);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => {});
    const last = localStorage.getItem(LAST_PAPER);
    if (!last) {
      setRestoring(false);
      return;
    }
    getPaper(last)
      .then((found) => found && showPaper(found))
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, [showPaper]);

  useEffect(() => {
    if (!paper) return;
    const save = () => {
      const key = highlightsKey(paper.id);
      try {
        localStorage.setItem(key, JSON.stringify(highlights));
      } catch {
        try {
          localStorage.setItem(key, JSON.stringify(withoutPrompts(highlights)));
        } catch {
          setNotice("Highlights can't be saved because browser storage is full.");
        }
      }
    };
    // Streaming changes this many times a second, and each save rewrites everything.
    if (!highlights.some((h) => h.turns.some((t) => t.status === "working"))) {
      save();
      return;
    }
    const timer = setTimeout(save, SAVE_WHILE_WORKING_MS);
    return () => clearTimeout(timer);
  }, [highlights, paper]);

  const paperId = paper?.id;
  const groqReady = health?.ready;
  useEffect(() => {
    if (!paperId || groqReady === undefined) return;
    if (!groqReady) {
      setGuideError(health?.message ?? "");
      return;
    }
    let current = true;
    setGuideError("");
    getGuide(paperId)
      .then((found) => current && setGuide(found))
      .catch((error) => current && setGuideError((error as Error).message));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId, groqReady, guideTry]);

  useEffect(() => {
    localStorage.setItem(HIDE_MARKS, String(hideMarks));
  }, [hideMarks]);

  const open = async (file: File) => {
    setNotice("");
    setUploading(true);
    try {
      showPaper(await uploadPaper(file));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const patchTurn = useCallback((highlightId: string, turnId: string, patch: (t: Turn) => Partial<Turn>) => {
    setHighlights((all) =>
      all.map((h) =>
        h.id !== highlightId
          ? h
          : { ...h, turns: h.turns.map((t) => (t.id === turnId ? { ...t, ...patch(t) } : t)) },
      ),
    );
  }, []);

  const stream = useCallback(
    async (highlight: Highlight, turn: Turn, repair?: AskBody["repair"]) => {
      const current = paperRef.current;
      if (!current) return;
      const controller = new AbortController();
      streams.current.set(turn.id, controller);
      let pending = "";
      let thoughts: { step: string; text: string }[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        const text = pending;
        const arrived = thoughts;
        pending = "";
        thoughts = [];
        if (!text && !arrived.length) return;
        patchTurn(highlight.id, turn.id, (t) => ({
          markdown: t.markdown + text,
          trace: arrived.reduce((trace, a) => appendReasoning(trace, a.step, a.text), t.trace),
        }));
      };
      const fail = (message: string) => {
        if (timer) clearTimeout(timer);
        flush();
        patchTurn(highlight.id, turn.id, () => ({ status: "error", error: message }));
      };
      let settled = false;
      try {
        await ask(
          current.id,
          {
            selection: highlight.text,
            page: highlight.page,
            intent: repair ? "repair" : turn.intent,
            question: turn.question,
            answer: turn.answer,
            history: historyBefore(highlight, turn.id),
            repair,
          },
          controller.signal,
          (event) => {
            if (event.type === "step" || event.type === "step_done") {
              if (timer) clearTimeout(timer);
              flush();
              patchTurn(highlight.id, turn.id, (t) => ({ trace: applyTraceEvent(t.trace, event, Date.now()) }));
            } else if (event.type === "reasoning") {
              const last = thoughts[thoughts.length - 1];
              if (last?.step === event.step) last.text += event.text;
              else thoughts.push({ step: event.step, text: event.text });
              timer ??= setTimeout(flush, TOKEN_FLUSH_MS);
            } else if (event.type === "token") {
              pending += event.text;
              timer ??= setTimeout(flush, TOKEN_FLUSH_MS);
            } else if (event.type === "result") {
              settled = true;
              if (timer) clearTimeout(timer);
              pending = "";
              flush();
              patchTurn(highlight.id, turn.id, (t) => ({
                status: "done",
                markdown: event.markdown,
                visual: event.visual,
                // A repair doesn't search the paper again, so the original sources still apply.
                sources: (t.sources.length && !event.sources.length) ? t.sources : event.sources,
                check: event.check,
                caveat: event.caveat,
                via: event.via,
                study: event.study ?? null,
              }));
            } else if (event.type === "error") {
              settled = true;
              fail(event.message);
            }
          },
        );
        if (!settled) fail("The connection closed before the answer finished. Try again.");
      } catch (error) {
        if (!controller.signal.aborted) fail((error as Error).message || "The server couldn't be reached. Try again.");
      } finally {
        streams.current.delete(turn.id);
      }
    },
    [patchTurn],
  );

  const addTurn = useCallback(
    (highlight: Highlight, intent: Intent, label: string, question = "", answer = "") => {
      const turn = newTurn(intent, label, question, answer);
      const updated = { ...highlight, turns: [...highlight.turns, turn] };
      setHighlights((all) => all.map((h) => (h.id === highlight.id ? updated : h)));
      stream(updated, turn);
    },
    [stream],
  );

  const startFromSelection = useCallback(
    (intent: "explain" | "visualize") => {
      if (!selection) return;
      const highlight: Highlight = {
        id: crypto.randomUUID(), text: selection.text, page: selection.page, marks: selection.marks, turns: [],
      };
      const turn = newTurn(intent, intent === "explain" ? "Explain" : "Visualize");
      const withTurn = { ...highlight, turns: [turn] };
      setHighlights((all) => [...all, withTurn]);
      setActiveId(highlight.id);
      setSelection(null);
      reader.current?.clearSelection();
      stream(withTurn, turn);
    },
    [selection, stream],
  );

  const shown = useMemo(
    () => highlights.find((h) => h.id === (activeId ?? lastActive.current)) ?? null,
    [highlights, activeId],
  );

  const retry = (turnId: string) => {
    if (!shown) return;
    const turn = shown.turns.find((t) => t.id === turnId);
    if (!turn) return;
    const reset: Turn = { ...turn, status: "working", trace: [], markdown: "", visual: null, study: null, error: "", repairs: 0 };
    const updated = { ...shown, turns: shown.turns.map((t) => (t.id === turnId ? reset : t)) };
    setHighlights((all) => all.map((h) => (h.id === shown.id ? updated : h)));
    stream(updated, reset);
  };

  // A visual that won't render gets one automatic repair before the reader sees a problem.
  const visualFailed = (turnId: string, error: string) => {
    if (!shown) return;
    const turn = shown.turns.find((t) => t.id === turnId);
    if (!turn?.visual) return;
    const { form, code } = turn.visual;
    const trace = markRenderFailure(turn.trace, error);
    if (turn.repairs >= 1) {
      patchTurn(shown.id, turnId, () => ({ trace, visual: null, status: "error", error: "This picture couldn't be displayed, even after a fix. Try again, or ask for an explanation." }));
      return;
    }
    const reset: Turn = { ...turn, trace, status: "working", visual: null, repairs: turn.repairs + 1 };
    patchTurn(shown.id, turnId, () => reset);
    stream(shown, reset, { form, code, error });
  };

  const removeHighlights = (ids: string[]) => {
    highlightsRef.current
      .filter((h) => ids.includes(h.id))
      .forEach((h) => h.turns.forEach((t) => streams.current.get(t.id)?.abort()));
    setHighlights((all) => all.filter((h) => !ids.includes(h.id)));
    setActiveId((id) => (id && ids.includes(id) ? null : id));
  };

  const remove = () => {
    if (shown) removeHighlights([shown.id]);
  };

  const onTerm = useCallback((term: GuideTerm | null, anchor: TextAnchor | null) => {
    clearTimeout(tipTimer.current);
    tipTimer.current = term && anchor
      ? setTimeout(() => setTip({ term, anchor }), TERM_SHOW_MS)
      : setTimeout(() => setTip(null), TERM_HIDE_MS);
  }, []);

  const lookUp = useCallback(async (click: CitationClick) => {
    const current = paperRef.current;
    if (!current) return;
    setTip(null);
    const key = `${click.page}:${click.numbers.join(",")}:${click.line.length}`;
    const known = citations.current.get(key);
    setCitation({ click, result: known ?? null, error: "" });
    if (known) return;
    const stillOpen = (c: typeof citation) => c?.click === click;
    try {
      const { anchor: _, ...body } = click;
      const result = await getCitation(current.id, body);
      citations.current.set(key, result);
      setCitation((c) => (stillOpen(c) ? { click, result, error: "" } : c));
    } catch (error) {
      setCitation((c) => (stillOpen(c) ? { click, result: null, error: (error as Error).message } : c));
    }
  }, []);

  const closeCitation = useCallback(() => setCitation(null), []);

  const exportMarkdown = () => {
    if (!paper) return;
    const url = URL.createObjectURL(new Blob([notesMarkdown(paper.name, highlights)], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = notesFilename(paper.name);
    link.click();
    URL.revokeObjectURL(url);
  };

  const finishPrinting = useCallback(() => setPrinting(false), []);

  const openHighlight = (highlight: Highlight) => {
    reader.current?.goToMark(highlight.page, highlight.marks[0]?.rects[0]?.y ?? 0);
    setActiveId(highlight.id);
    if (window.innerWidth < 760) setSide(null);
  };

  const goToPage = (page: number) => {
    reader.current?.goToPage(page);
    setTip(null);
    if (window.innerWidth < 760) setSide(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (citation) {
          setCitation(null);
        } else if (selection) {
          reader.current?.clearSelection();
          setSelection(null);
        } else if (activeId) {
          setActiveId(null);
        } else {
          setSide(null);
        }
        return;
      }
      if (!selection || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "e") startFromSelection("explain");
      if (e.key === "v") startFromSelection("visualize");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, startFromSelection, citation, activeId]);

  const filePicker = (
    <input
      ref={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) open(file);
      }}
    />
  );

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) open(file);
    },
  };

  if (restoring) return null;

  const setupMessage = health?.message;

  if (!paper) {
    return (
      <main className={`welcome${dragging ? " dragging" : ""}`} {...dropHandlers}>
        {filePicker}
        <h1>Open a paper</h1>
        <p>Highlight anything you don't understand, and get an explanation or a picture beside the page.</p>
        <button className="primary" type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? "Opening" : "Choose a PDF"}
        </button>
        <p className="small">or drop one here</p>
        {notice && <p className="welcome-notice" role="alert">{notice}</p>}
        {setupMessage && <p className="welcome-notice">{setupMessage}</p>}
      </main>
    );
  }

  const pillStyle = selection && {
    left: Math.min(window.innerWidth - 110, Math.max(110, selection.anchor.left + selection.anchor.width / 2)),
    top: selection.anchor.top > 110 ? selection.anchor.top - 12 : selection.anchor.bottom + 12,
    transform: `translate(-50%, ${selection.anchor.top > 110 ? "-100%" : "0"})`,
  };

  return (
    <div className={`app${activeId ? " sheet-open" : ""}${side ? " side-open" : ""}${dragging ? " dragging" : ""}`} {...dropHandlers}>
      {filePicker}
      <header className="bar">
        <span className="bar-start">
          <span className="title" title={paper.name}>{paper.name}</span>
          {health && <span className="where" title={`Your highlights, your questions, and text from this paper are sent to Groq (${health.model})`}>Using Groq</span>}
        </span>
        <span className="page-count">Page {page} of {paper.pages}</span>
        <div className="bar-actions">
          <button className="icon" type="button" aria-label="Zoom out" onClick={() => reader.current?.zoom(1 / 1.15)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button className="icon" type="button" aria-label="Zoom in" onClick={() => reader.current?.zoom(1.15)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button className="quiet" type="button" aria-pressed={side === "guide"} onClick={() => setSide(side === "guide" ? null : "guide")}>
            Guide
          </button>
          <button className="quiet" type="button" aria-pressed={side === "highlights"} onClick={() => setSide(side === "highlights" ? null : "highlights")}>
            Highlights{highlights.length > 0 ? ` (${highlights.length})` : ""}
          </button>
          <button className="quiet" type="button" onClick={() => fileInput.current?.click()}>
            {uploading ? "Opening" : "Open another"}
          </button>
        </div>
      </header>

      <div className="stage">
        <PdfReader
          key={paper.id}
          ref={reader}
          url={paperFileUrl(paper.id)}
          highlights={hideMarks ? highlights.filter((h) => h.id === activeId) : highlights}
          activeId={activeId}
          terms={guide?.terms ?? []}
          references={paper.references}
          onTerm={onTerm}
          onCitation={lookUp}
          onSelection={setSelection}
          onOpenHighlight={setActiveId}
          onPage={setPage}
          onFailure={setNotice}
        />
      </div>

      {pillStyle && (
        <div className="pill" style={pillStyle} role="toolbar" aria-label="Highlight actions" onPointerDown={(e) => e.preventDefault()}>
          <button type="button" onClick={() => startFromSelection("explain")}>Explain</button>
          <button type="button" onClick={() => startFromSelection("visualize")}>Visualize</button>
        </div>
      )}

      {side && (
        <Side
          tab={side}
          guide={guide}
          guideError={guideError}
          highlights={highlights}
          activeId={activeId}
          hidden={hideMarks}
          onTab={setSide}
          onClose={() => setSide(null)}
          onRetryGuide={() => setGuideTry((n) => n + 1)}
          onPage={goToPage}
          onOpenHighlight={openHighlight}
          onRemoveHighlight={(id) => removeHighlights([id])}
          onClearHighlights={() => removeHighlights(highlights.map((h) => h.id))}
          onToggleHidden={() => setHideMarks(!hideMarks)}
          onExportMarkdown={exportMarkdown}
          onExportPdf={() => setPrinting(true)}
        />
      )}

      {tip && (
        <TermTip
          term={tip.term}
          anchor={tip.anchor}
          onEnter={() => clearTimeout(tipTimer.current)}
          onLeave={() => onTerm(null, null)}
          onPage={goToPage}
        />
      )}
      {citation && (
        <CitationCard
          anchor={citation.click.anchor}
          numbers={citation.click.numbers}
          result={citation.result}
          error={citation.error}
          onClose={closeCitation}
          onRetry={() => lookUp(citation.click)}
        />
      )}
      {printing && <NotesPrint name={paper.name} highlights={highlights} onDone={finishPrinting} />}

      {highlights.length === 0 && !selection && !notice && (
        <p className="hint">{setupMessage || "Select any passage you don't understand."}</p>
      )}
      {notice && <p className="toast" role="alert">{notice}</p>}

      <Sheet
        highlight={shown}
        open={Boolean(activeId)}
        onClose={() => setActiveId(null)}
        onRemove={remove}
        onAsk={(intent, label, question, answer) => shown && addTurn(shown, intent, label, question, answer)}
        onRetry={retry}
        onVisualFailure={visualFailed}
        onPage={goToPage}
      />
    </div>
  );
}
