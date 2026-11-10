import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatDuration, formatElapsed, stepHeadline, traceTotals } from "./lib";
import type { ModelRecord, TraceStep, Turn } from "./types";

const AGENT_NAMES: Record<TraceStep["agent"], string> = {
  coordinator: "Coordinator",
  librarian: "Librarian",
  tutor: "Tutor",
  illustrator: "Illustrator",
  reviewer: "Reviewer",
  pathfinder: "Pathfinder",
  examiner: "Examiner",
  grader: "Grader",
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Follows the newest words as the model writes them. */
function LiveThought({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return <div className="thought" ref={box}>{text}</div>;
}

function Raw({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="raw">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/** What one model request sent and received, for the study aids that aren't part of a turn's steps. */
export function RecordDetails({ record }: { record: ModelRecord }) {
  return (
    <details className="record">
      <summary>How this was made</summary>
      <div className="step-body">
        <p>{record.model}, {formatDuration(record.duration_ms)}{record.usage ? `, ${record.usage.input} tokens in, ${record.usage.output} out` : ""}.</p>
        {record.reasoning && <div><h4>The model's reasoning</h4><div className="thought-full">{record.reasoning}</div></div>}
        <Raw label="exact reply"><pre>{record.output}</pre></Raw>
        <Raw label="exact prompt">
          <h4>Instructions</h4>
          <pre>{record.prompt.system}</pre>
          <h4>Message</h4>
          <pre>{record.prompt.user}</pre>
        </Raw>
      </div>
    </details>
  );
}

function PlanDetails({ step }: { step: TraceStep }) {
  const { plan } = step;
  if (!plan) return null;
  const terms = Array.isArray(plan.terms) ? plan.terms.map(String) : [];
  return (
    <dl className="facts">
      {plan.brief && <><dt>Likely need</dt><dd>{plan.brief}</dd></>}
      {plan.kind && <><dt>Type</dt><dd>{plan.kind}</dd></>}
      {terms.length > 0 && <><dt>Search terms</dt><dd>{terms.join(", ")}</dd></>}
      {plan.visual_form && <><dt>If drawn</dt><dd>{plan.visual_form}</dd></>}
    </dl>
  );
}

function LibrarianDetails({ step, onPage }: { step: TraceStep; onPage(page: number): void }) {
  return (
    <>
      <p>This step is a keyword search of this paper (BM25). It doesn't use an AI model, so it has no reasoning to show.</p>
      {step.query && <div><h4>Searched for</h4><p>{step.query}</p></div>}
      {(step.passages ?? []).map((passage, i) => (
        <div className="passage" key={i}>
          <p>
            <button className="cite" type="button" onClick={() => onPage(passage.page)}>Page {passage.page}</button>
            {passage.source === "highlight" ? ", around your highlight" : `, match score ${passage.score}`}
          </p>
          <p className="passage-text">{passage.text}</p>
        </div>
      ))}
    </>
  );
}

function StepDetails({ step, onPage }: { step: TraceStep; onPage(page: number): void }) {
  const usesModel = step.agent !== "librarian";
  return (
    <div className="step-body">
      <p>{AGENT_NAMES[step.agent]}{step.model ? `, using ${step.model}` : ""}{step.usage ? `. ${step.usage.input} tokens in, ${step.usage.output} out.` : ""}</p>
      {step.error && <p className="warning">{step.error}</p>}
      {step.syntax_error && <div><h4>What the syntax check found</h4><pre className="check-error">{step.syntax_error}</pre></div>}
      {step.render_error && <div><h4>Why it wouldn't display</h4><p className="warning">{step.render_error}</p></div>}
      {step.repair_error && <div><h4>What it was asked to fix</h4><p>{step.repair_error}</p></div>}
      {step.issues && <div><h4>What the Reviewer found</h4><p className="warning">{step.issues}</p></div>}
      {step.agent === "coordinator" && <PlanDetails step={step} />}
      {step.agent === "librarian" && <LibrarianDetails step={step} onPage={onPage} />}
      {step.code && <Raw label="picture code"><pre>{step.code}</pre></Raw>}
      {step.caption && <div><h4>Caption</h4><p>{step.caption}</p></div>}
      {usesModel && step.status !== "running" && (
        step.reasoning ? (
          <div>
            <h4>The model's reasoning</h4>
            <p>Written by the model, so it may not fully match how it reached its answer.</p>
            <div className="thought-full">{step.reasoning}</div>
          </div>
        ) : (
          <p>The model returned no separate reasoning for this step.</p>
        )
      )}
      {step.output && (
        <Raw label={step.agent === "tutor" ? "full text" : "exact reply"}>
          <pre>{step.output}</pre>
        </Raw>
      )}
      {step.prompt ? (
        <Raw label="exact prompt">
          <h4>Instructions</h4>
          <pre>{step.prompt.system}</pre>
          <h4>Message</h4>
          <pre>{step.prompt.user}</pre>
        </Raw>
      ) : (
        usesModel && step.status === "done" && <p>The exact prompt was removed to save browser storage.</p>
      )}
    </div>
  );
}

function Step({ step, now, onPage }: { step: TraceStep; now: number; onPage(page: number): void }) {
  const running = step.status === "running";
  const alert = step.outcome === "failed" || step.outcome === "fallback" || step.outcome === "rejected";
  const time = running ? formatElapsed(Math.max(0, now - step.startedAt)) : step.duration_ms != null ? formatDuration(step.duration_ms) : "";
  return (
    <li className={`step${running ? " running" : ""}${alert ? " alert" : ""}${step.status === "interrupted" ? " interrupted" : ""}`}>
      {running ? <span className="breath" aria-hidden="true" /> : <span className="step-dot" aria-hidden="true" />}
      <details>
        <summary>
          <span>{stepHeadline(step)}</span>
          <span className="time">{time}</span>
        </summary>
        <StepDetails step={step} onPage={onPage} />
      </details>
      {running && step.reasoning && <LiveThought text={step.reasoning} />}
    </li>
  );
}

export function Trace({ turn, onPage }: { turn: Turn; onPage(page: number): void }) {
  const working = turn.status === "working";
  const now = useNow(working);
  const [choice, setChoice] = useState<boolean | null>(null);
  const { trace } = turn;
  // The steps have the stage until there's an answer to read, and stay one click away after that.
  const open = choice ?? ((working && !turn.markdown) || turn.status === "error");
  const current = trace.find((s) => s.status === "running");
  const totals = traceTotals(trace);
  const elapsed = totals.ms + (current ? Math.max(0, now - current.startedAt) : 0);
  const count = `${totals.steps} ${totals.steps === 1 ? "step" : "steps"}`;
  // Once the list is open it names the current step, so the heading doesn't repeat it.
  const label = !working ? `How this was made: ${count}` : open ? "What the team is doing" : current ? stepHeadline(current) : "Finishing";

  return (
    <div className="trace">
      <span className="visually-hidden" role="status" aria-live="polite">{current ? stepHeadline(current) : ""}</span>
      <button className="trace-toggle" type="button" aria-expanded={open} onClick={() => setChoice(!open)}>
        <svg className="chevron" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M3.5 1.5L7 5 3.5 8.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{label}</span>
        <span className="time">{working ? formatElapsed(elapsed) : formatDuration(elapsed)}</span>
      </button>
      {open && (
        <ol className="steps">
          {trace.map((step) => <Step key={step.id} step={step} now={now} onPage={onPage} />)}
        </ol>
      )}
    </div>
  );
}
