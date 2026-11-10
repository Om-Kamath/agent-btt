import { useState } from "react";
import { sortedHighlights } from "./lib";
import { RecordDetails } from "./Trace";
import type { Guide, Highlight } from "./types";

export type SideTab = "guide" | "terms" | "highlights";

const TABS: { id: SideTab; label: string }[] = [
  { id: "guide", label: "Guide" },
  { id: "terms", label: "Terms" },
  { id: "highlights", label: "Highlights" },
];

interface Props {
  tab: SideTab;
  guide: Guide | null;
  guideError: string;
  highlights: Highlight[];
  activeId: string | null;
  hidden: boolean;
  onTab(tab: SideTab): void;
  onClose(): void;
  onRetryGuide(): void;
  onPage(page: number): void;
  onOpenHighlight(highlight: Highlight): void;
  onRemoveHighlight(id: string): void;
  onClearHighlights(): void;
  onToggleHidden(): void;
  onExportMarkdown(): void;
  onExportPdf(): void;
}

function Waiting({ error, onRetry }: { error: string; onRetry(): void }) {
  if (error) {
    return (
      <div className="problem" role="alert">
        <p>{error}</p>
        <button className="chip" type="button" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  return <p className="status" role="status"><span className="breath" aria-hidden="true" />Reading the paper</p>;
}

function GuideTab({ guide, error, onRetry, onPage }: { guide: Guide | null; error: string; onRetry(): void; onPage(page: number): void }) {
  if (!guide) return <Waiting error={error} onRetry={onRetry} />;
  const list = (items: Guide["read_first"]) => (
    <ul className="sections">
      {items.map((s, i) => (
        <li key={i}>
          <button type="button" onClick={() => onPage(s.page)}>
            <span>{s.title}</span>
            <span className="time">p.{s.page}</span>
          </button>
          {s.why && <p>{s.why}</p>}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <p className="claim">{guide.claim}</p>
      {guide.read_first.length > 0 && <><h3>Read first</h3>{list(guide.read_first)}</>}
      {guide.skim.length > 0 && <><h3>Safe to skim</h3>{list(guide.skim)}</>}
      <p className="small-note">Written by the model from the start of each page, so it can miss things.</p>
      {guide.record && <RecordDetails record={guide.record} />}
    </>
  );
}

function TermsTab({ guide, error, onRetry, onPage }: { guide: Guide | null; error: string; onRetry(): void; onPage(page: number): void }) {
  if (!guide) return <Waiting error={error} onRetry={onRetry} />;
  if (!guide.terms.length) return <p className="small-note">No terms were found in this paper.</p>;
  return (
    <>
      <p className="small-note">Hover over any of these in the paper to see its definition. Definitions are written by the model, and first appearances come from the paper's text.</p>
      <dl className="terms">
        {guide.terms.map((t) => (
          <div key={t.term}>
            <dt>
              <span>{t.term}</span>
              <button className="cite" type="button" onClick={() => onPage(t.first_page)}>p.{t.first_page}</button>
            </dt>
            <dd>{t.definition}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function HighlightsTab(props: Props) {
  const { highlights, activeId, hidden } = props;
  const [clearing, setClearing] = useState(false);
  const hasNotes = highlights.some((h) => h.turns.some((t) => t.status === "done"));
  if (!highlights.length) return <p className="small-note">Passages you highlight will be listed here.</p>;
  return (
    <>
      <div className="list-actions">
        <button className="chip" type="button" aria-pressed={hidden} onClick={props.onToggleHidden}>
          {hidden ? "Show on page" : "Hide on page"}
        </button>
        <button className="chip" type="button" disabled={!hasNotes} onClick={props.onExportMarkdown}>Export Markdown</button>
        <button className="chip" type="button" disabled={!hasNotes} onClick={props.onExportPdf}>Export PDF</button>
      </div>
      <ul className="highlight-list">
        {sortedHighlights(highlights).map((h) => (
          <li key={h.id} className={h.id === activeId ? "current" : undefined}>
            <button type="button" className="highlight-open" onClick={() => props.onOpenHighlight(h)}>
              <span className="highlight-text">{h.text}</span>
              <span className="time">Page {h.page}</span>
            </button>
            <button className="icon" type="button" aria-label={`Remove highlight on page ${h.page}`} onClick={() => props.onRemoveHighlight(h.id)}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </li>
        ))}
      </ul>
      {clearing ? (
        <p className="clear-confirm">
          Remove all {highlights.length} highlights and their answers? This can't be undone.
          <span>
            <button className="chip" type="button" autoFocus onClick={() => setClearing(false)}>Keep them</button>
            <button className="chip danger" type="button" onClick={() => { setClearing(false); props.onClearHighlights(); }}>Remove all</button>
          </span>
        </p>
      ) : (
        <button className="quiet" type="button" onClick={() => setClearing(true)}>Remove all highlights</button>
      )}
    </>
  );
}

export function Side(props: Props) {
  const { tab, guide, guideError, onRetryGuide, onPage } = props;
  return (
    <aside className="side" aria-label="Paper guide and highlights">
      <header className="side-head">
        <span className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => props.onTab(t.id)}>{t.label}</button>
          ))}
        </span>
        <button className="icon" type="button" aria-label="Close panel" onClick={props.onClose}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="side-body" role="tabpanel">
        {tab === "guide" && <GuideTab guide={guide} error={guideError} onRetry={onRetryGuide} onPage={onPage} />}
        {tab === "terms" && <TermsTab guide={guide} error={guideError} onRetry={onRetryGuide} onPage={onPage} />}
        {tab === "highlights" && <HighlightsTab {...props} />}
      </div>
    </aside>
  );
}
