import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { CitationResult, GuideTerm } from "./types";
import { RecordDetails } from "./Trace";

export interface Anchor { left: number; top: number; bottom: number }

function placeNear(anchor: Anchor, width: number): CSSProperties {
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left));
  // Opens toward whichever side of the text has more room.
  return anchor.top > window.innerHeight / 2
    ? { left, width, bottom: window.innerHeight - anchor.top + 8, maxHeight: anchor.top - 60 }
    : { left, width, top: anchor.bottom + 8, maxHeight: window.innerHeight - anchor.bottom - 24 };
}

interface TipProps {
  term: GuideTerm;
  anchor: Anchor;
  onEnter(): void;
  onLeave(): void;
  onPage(page: number): void;
}

export function TermTip({ term, anchor, onEnter, onLeave, onPage }: TipProps) {
  return (
    <div className="popover term-tip" role="tooltip" style={placeNear(anchor, 300)} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <strong>{term.term}</strong>
      <p>{term.definition}</p>
      <button className="cite" type="button" onClick={() => onPage(term.first_page)}>First appears on page {term.first_page}</button>
    </div>
  );
}

interface CardProps {
  anchor: Anchor;
  numbers: number[];
  result: CitationResult | null;
  error: string;
  onClose(): void;
  onRetry(): void;
}

export function CitationCard({ anchor, numbers, result, error, onClose, onRetry }: CardProps) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  return (
    <div className="popover citation" ref={card} role="dialog" aria-label={`Reference ${numbers.join(", ")}`} style={placeNear(anchor, 380)}>
      <button className="icon close" type="button" aria-label="Close reference" onClick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {error && (
        <>
          <p>{error}</p>
          <button className="chip" type="button" onClick={onRetry}>Try again</button>
        </>
      )}
      {!result && !error && <p className="status"><span className="breath" aria-hidden="true" />Finding reference {numbers.join(", ")}</p>}
      {result && (
        <>
          <h4>From the paper's reference list</h4>
          {result.references.map((r) => <p className="reference" key={r.number}><b>[{r.number}]</b> {r.text}</p>)}
          {result.missing.length > 0 && <p className="small-note">No entry found for {result.missing.join(", ")}.</p>}
          {result.what && <><h4>What it is</h4><p>{result.what}</p></>}
          {result.why && <><h4>Why it's cited here</h4><p>{result.why}</p></>}
          {result.why_error && <p className="small-note">{result.why_error}</p>}
          {(result.what || result.why) && <p className="small-note">Worked out by the model from the reference and the text around it. It hasn't read the cited work.</p>}
          {result.record && <RecordDetails record={result.record} />}
        </>
      )}
    </div>
  );
}
