import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask, getHealth, getPaper, paperFileUrl, uploadPaper } from "./api";
import type { AskBody, Health } from "./api";
import { PdfReader } from "./PdfReader";
import type { ReaderHandle, SelectionInfo } from "./PdfReader";
import { Sheet } from "./Sheet";
import { ConfirmCloud, ProviderSwitch } from "./ProviderSwitch";
import type { Highlight, Intent, Paper, ProviderName, Turn } from "./types";

const LAST_PAPER = "margin.lastPaper";
const highlightsKey = (paperId: string) => `margin.highlights.${paperId}`;
const TOKEN_FLUSH_MS = 70;

function loadHighlights(paperId: string): Highlight[] {
  try {
    const saved: Highlight[] = JSON.parse(localStorage.getItem(highlightsKey(paperId)) ?? "[]");
    return saved.map((h) => ({
      ...h,
      turns: h.turns.map((t) =>
        t.status === "working"
          ? { ...t, status: "error" as const, error: "This answer was interrupted when the page closed." }
          : t,
      ),
    }));
  } catch {
    return [];
  }
}

function newTurn(intent: Intent, label: string, question = ""): Turn {
  return {
    id: crypto.randomUUID(), intent, label, question, status: "working", markdown: "", visual: null,
    sources: [], check: "skipped", caveat: "", error: "", repairs: 0,
  };
}

function historyBefore(highlight: Highlight, turnId: string): AskBody["history"] {
  const history: NonNullable<AskBody["history"]> = [];
  for (const turn of highlight.turns) {
    if (turn.id === turnId) break;
    if (turn.status !== "done") continue;
    history.push({ role: "user", content: turn.label });
    history.push({ role: "assistant", content: turn.markdown || `Drew a picture: ${turn.visual?.caption ?? ""}` });
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
  // Deliberately not saved: every session starts on the configured default, so using Groq once
  // can't carry over to a later session without anyone noticing.
  const [active, setActive] = useState<ProviderName | null>(null);
  const [confirmingCloud, setConfirmingCloud] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const reader = useRef<ReaderHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const activeRef = useRef(active);
  activeRef.current = active;
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
    localStorage.setItem(LAST_PAPER, next.id);
  }, []);

  useEffect(() => {
    getHealth()
      .then((found) => {
        setHealth(found);
        if (found) setActive(found.default);
      })
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
    try {
      localStorage.setItem(highlightsKey(paper.id), JSON.stringify(highlights));
    } catch {
      setNotice("Highlights can't be saved because browser storage is full.");
    }
  }, [highlights, paper]);

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
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        if (!pending) return;
        const text = pending;
        pending = "";
        patchTurn(highlight.id, turn.id, (t) => ({ markdown: t.markdown + text }));
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
            history: historyBefore(highlight, turn.id),
            repair,
            // Always the current choice, even for a retry of an answer that came from elsewhere.
            provider: activeRef.current ?? undefined,
          },
          controller.signal,
          (event) => {
            if (event.type === "step") {
              patchTurn(highlight.id, turn.id, () => ({ agent: event.agent }));
            } else if (event.type === "token") {
              pending += event.text;
              timer ??= setTimeout(flush, TOKEN_FLUSH_MS);
            } else if (event.type === "result") {
              settled = true;
              if (timer) clearTimeout(timer);
              pending = "";
              patchTurn(highlight.id, turn.id, () => ({
                status: "done",
                markdown: event.markdown,
                visual: event.visual,
                sources: event.sources,
                check: event.check,
                caveat: event.caveat,
                via: event.via,
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
    (highlight: Highlight, intent: Intent, label: string, question = "") => {
      const turn = newTurn(intent, label, question);
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
    const reset: Turn = { ...turn, status: "working", markdown: "", visual: null, error: "", agent: undefined, repairs: 0 };
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
    if (turn.repairs >= 1) {
      patchTurn(shown.id, turnId, () => ({ visual: null, status: "error", error: "This picture couldn't be drawn." }));
      return;
    }
    const reset: Turn = { ...turn, status: "working", visual: null, agent: "illustrator", repairs: turn.repairs + 1 };
    patchTurn(shown.id, turnId, () => reset);
    stream(shown, reset, { form, code, error });
  };

  const remove = () => {
    if (!shown) return;
    shown.turns.forEach((t) => streams.current.get(t.id)?.abort());
    setHighlights((all) => all.filter((h) => h.id !== shown.id));
    setActiveId(null);
  };

  const chooseProvider = (next: ProviderName) => {
    if (next === active) return;
    const target = health?.providers[next];
    if (!target) return;
    if (!target.local && !target.ready) {
      setNotice(target.message);
      return;
    }
    if (!target.local) {
      setConfirmingCloud(true);
      return;
    }
    switchTo(next);
  };

  const switchTo = (next: ProviderName) => {
    setNotice("");
    setConfirmingCloud(false);
    setActive(next);
    getHealth(next).then((found) => found && setHealth(found)).catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmingCloud) return;
      if (e.key === "Escape") {
        if (selection) {
          reader.current?.clearSelection();
          setSelection(null);
        } else {
          setActiveId(null);
        }
        return;
      }
      if (!selection || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "e") startFromSelection("explain");
      if (e.key === "v") startFromSelection("visualize");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, startFromSelection, confirmingCloud]);

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

  const current = active ? health?.providers[active] : undefined;

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
        {current?.message && <p className="welcome-notice">{current.message}</p>}
        {current?.local && !current.message && <p className="welcome-notice">Your papers stay on this computer.</p>}
      </main>
    );
  }

  const pillStyle = selection && {
    left: Math.min(window.innerWidth - 110, Math.max(110, selection.anchor.left + selection.anchor.width / 2)),
    top: selection.anchor.top > 110 ? selection.anchor.top - 12 : selection.anchor.bottom + 12,
    transform: `translate(-50%, ${selection.anchor.top > 110 ? "-100%" : "0"})`,
  };

  return (
    <div className={`app${activeId ? " sheet-open" : ""}${dragging ? " dragging" : ""}`} {...dropHandlers}>
      {filePicker}
      <header className="bar">
        <span className="bar-start">
          <span className="title" title={paper.name}>{paper.name}</span>
          {health && active && <ProviderSwitch providers={health.providers} active={active} onChoose={chooseProvider} />}
        </span>
        <span className="page-count">Page {page} of {paper.pages}</span>
        <div className="bar-actions">
          <button className="icon" type="button" aria-label="Zoom out" onClick={() => reader.current?.zoom(1 / 1.15)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button className="icon" type="button" aria-label="Zoom in" onClick={() => reader.current?.zoom(1.15)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
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
          highlights={highlights}
          activeId={activeId}
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

      {highlights.length === 0 && !selection && !notice && (
        <p className="hint">{current?.message || "Select any passage you don't understand."}</p>
      )}
      {notice && <p className="toast" role="alert">{notice}</p>}

      {confirmingCloud && <ConfirmCloud onConfirm={() => switchTo("groq")} onCancel={() => setConfirmingCloud(false)} />}

      <Sheet
        highlight={shown}
        open={Boolean(activeId)}
        onClose={() => setActiveId(null)}
        onRemove={remove}
        onAsk={(intent, label, question) => shown && addTurn(shown, intent, label, question)}
        onRetry={retry}
        onVisualFailure={visualFailed}
        onPage={(n) => reader.current?.goToPage(n)}
      />
    </div>
  );
}
