import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Answer } from "./Sheet";
import { sortedHighlights, turnAsText } from "./lib";
import type { Highlight } from "./types";
import { VisualView } from "./Visual";

const DIAGRAM_WAIT_MS = 6000;

/** The notes as a printable page. The browser's print dialog saves it as a PDF, with math and diagrams intact. */
export function NotesPrint({ name, highlights, onDone }: { name: string; highlights: Highlight[]; onDone(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const notes = sortedHighlights(highlights)
    .map((h) => ({ ...h, turns: h.turns.filter((t) => t.status === "done") }))
    .filter((h) => h.turns.length);
  const diagrams = notes.flatMap((h) => h.turns).filter((t) => t.visual?.form === "mermaid").length;

  useEffect(() => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => done.current();
    const whenReady = () => {
      const drawn = root.current?.querySelectorAll(".diagram svg").length ?? 0;
      if (drawn < diagrams && Date.now() - started < DIAGRAM_WAIT_MS) {
        timer = setTimeout(whenReady, 100);
        return;
      }
      window.addEventListener("afterprint", finish, { once: true });
      window.print();
    };
    timer = setTimeout(whenReady, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
    };
  }, [diagrams]);

  return createPortal(
    <div className="print-root" ref={root}>
      <h1>Notes on {name}</h1>
      {notes.map((h) => (
        <section key={h.id}>
          <h2>Page {h.page}</h2>
          <blockquote>{h.text}</blockquote>
          {h.turns.map((t) => (
            <div key={t.id} className="print-turn">
              <h3>{t.label}</h3>
              {t.markdown && <Answer markdown={t.markdown} onPage={() => {}} />}
              {t.visual?.form === "mermaid" && <VisualView visual={t.visual} onFailure={() => {}} />}
              {t.visual?.form === "html" && <p>{t.visual.caption} (Interactive picture: open it in Margin.)</p>}
              {t.study && <p className="print-study">{turnAsText(t)}</p>}
              {t.check === "flagged" && <p><strong>Double-check this one.</strong> {t.caveat}</p>}
            </div>
          ))}
        </section>
      ))}
    </div>,
    document.body,
  );
}
