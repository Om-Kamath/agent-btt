import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { linkCitations, normalizeMath } from "./lib";
import type { Agent, Highlight, Intent, Turn } from "./types";
import { VisualView } from "./Visual";

const AGENT_LABELS: Record<Agent, string> = {
  coordinator: "Reading your highlight",
  librarian: "Finding related passages",
  tutor: "Writing an explanation",
  illustrator: "Drawing a picture",
  reviewer: "Checking against the paper",
};

function Status({ label }: { label: string }) {
  return (
    <p className="status" role="status" aria-live="polite">
      <span className="breath" aria-hidden="true" />
      {label}
    </p>
  );
}

function Answer({ markdown, onPage }: { markdown: string; onPage(page: number): void }) {
  return (
    <div className="answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        disallowedElements={["img"]}
        components={{
          a({ href, children }): ReactNode {
            const page = href?.match(/^#page-(\d+)$/);
            if (page) {
              return (
                <button className="cite" type="button" onClick={() => onPage(Number(page[1]))}>
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {normalizeMath(linkCitations(markdown))}
      </ReactMarkdown>
    </div>
  );
}

function CheckNote({ turn, onPage }: { turn: Turn; onPage(page: number): void }) {
  const flag = useRef<HTMLParagraphElement>(null);
  const flagged = turn.check === "flagged";

  // A warning about the answer has to be seen, even if it lands below the fold.
  useEffect(() => {
    if (flagged) flag.current?.scrollIntoView({ block: "nearest" });
  }, [flagged]);

  const pages = [...new Set(turn.sources.map((s) => s.page))].sort((a, b) => a - b);
  return (
    <div className="note">
      {turn.check === "passed" && <p>Reviewed against the paper. Mistakes are still possible.</p>}
      {turn.check === "unchecked" && <p>This answer wasn't reviewed against the paper.</p>}
      {turn.check === "flagged" && (
        <p className="flag" ref={flag}>
          <strong>Double-check this one.</strong> The review found a possible problem: {turn.caveat}
        </p>
      )}
      {turn.via && (
        <p>Written by {turn.via.model} {turn.via.local ? "on this computer" : turn.via.provider === "groq" ? "on Groq" : "through Ollama"}.</p>
      )}
      {pages.length > 0 && (
        <p>
          Based on {pages.length === 1 ? "page" : "pages"}{" "}
          {pages.map((page, i) => (
            <span key={page}>
              {i > 0 && ", "}
              <button className="cite" type="button" onClick={() => onPage(page)}>
                {page}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function TurnView(props: {
  turn: Turn;
  first: boolean;
  onPage(page: number): void;
  onRetry(): void;
  onVisualFailure(error: string): void;
}) {
  const { turn, first, onPage, onRetry, onVisualFailure } = props;
  const quiet = turn.status === "working" && !turn.markdown;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (first) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    // Only on arrival: following the text as it streams would pull the page out from under the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="turn" ref={ref}>
      {!first && <h3 className="turn-label">{turn.label}</h3>}
      {turn.markdown && <Answer markdown={turn.markdown} onPage={onPage} />}
      {turn.visual && <VisualView visual={turn.visual} onFailure={onVisualFailure} />}
      {turn.status === "working" && (
        <Status label={turn.agent ? AGENT_LABELS[turn.agent] : quiet ? "Reading your highlight" : "Finishing"} />
      )}
      {turn.status === "done" && <CheckNote turn={turn} onPage={onPage} />}
      {turn.status === "error" && (
        <div className="problem" role="alert">
          <p>{turn.error}</p>
          <button className="chip" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

interface SheetProps {
  highlight: Highlight | null;
  open: boolean;
  onClose(): void;
  onRemove(): void;
  onAsk(intent: Intent, label: string, question?: string): void;
  onRetry(turnId: string): void;
  onVisualFailure(turnId: string, error: string): void;
  onPage(page: number): void;
}

export function Sheet(props: SheetProps) {
  const { highlight, open, onClose, onRemove, onAsk, onRetry, onVisualFailure, onPage } = props;
  const [question, setQuestion] = useState("");
  const [expanded, setExpanded] = useState(false);
  const highlightId = highlight?.id;

  useEffect(() => {
    setExpanded(false);
    setQuestion("");
  }, [highlightId]);

  const turns = highlight?.turns ?? [];
  const busy = turns.some((t) => t.status === "working");
  const hasExplanation = turns.some((t) => t.markdown);
  const longQuote = (highlight?.text.length ?? 0) > 220;

  const submit = () => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion("");
    onAsk("question", text, text);
  };

  return (
    <aside className={`sheet${open ? " open" : ""}`} aria-label="Explanation" inert={!open}>
      <header className="sheet-head">
        <button className="quiet" type="button" onClick={onRemove}>
          Remove highlight
        </button>
        <button className="icon" type="button" onClick={onClose} aria-label="Close explanation">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="sheet-body">
        {highlight && (
          <>
            <blockquote className={`quote${longQuote && !expanded ? " clamped" : ""}`}>
              <mark>{highlight.text}</mark>
            </blockquote>
            {longQuote && (
              <button className="quiet" type="button" onClick={() => setExpanded(!expanded)}>
                {expanded ? "Show less" : "Show all"}
              </button>
            )}
            {turns.map((turn, i) => (
              <TurnView
                key={turn.id}
                turn={turn}
                first={i === 0}
                onPage={onPage}
                onRetry={() => onRetry(turn.id)}
                onVisualFailure={(error) => onVisualFailure(turn.id, error)}
              />
            ))}
          </>
        )}
      </div>

      <footer className="sheet-foot">
        <div className="chips">
          {hasExplanation ? (
            <>
              <button className="chip" type="button" disabled={busy} onClick={() => onAsk("simplify", "Simpler")}>
                Simpler
              </button>
              <button className="chip" type="button" disabled={busy} onClick={() => onAsk("deepen", "Go deeper")}>
                Go deeper
              </button>
              <button className="chip" type="button" disabled={busy} onClick={() => onAsk("example", "Example")}>
                Example
              </button>
            </>
          ) : (
            <button className="chip" type="button" disabled={busy} onClick={() => onAsk("explain", "Explain")}>
              Explain
            </button>
          )}
          <button className="chip" type="button" disabled={busy} onClick={() => onAsk("visualize", "Visualize")}>
            Visualize
          </button>
        </div>
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this passage"
            aria-label="Ask about this passage"
            maxLength={2000}
          />
          <button type="submit" disabled={!question.trim() || busy} aria-label="Send question">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </footer>
    </aside>
  );
}
