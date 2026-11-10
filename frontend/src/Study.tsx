import { useState } from "react";
import { Answer } from "./Sheet";
import type { Intent, Turn } from "./types";

const VERDICTS = { correct: "You've got it", partly: "Partly there", not_yet: "Not yet" } as const;

function AnswerForm({ question, label, onAsk }: { question: string; label: string; onAsk: Props["onAsk"] }) {
  const [answer, setAnswer] = useState("");
  const text = answer.trim();
  return (
    <form
      className="answer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text) onAsk("grade", "Your answer", question, text);
      }}
    >
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Answer in your own words"
        aria-label="Your answer"
        rows={4}
        maxLength={4000}
      />
      <button className="chip" type="submit" disabled={!text}>{label}</button>
    </form>
  );
}

interface Props {
  turn: Turn;
  last: boolean;
  busy: boolean;
  onAsk(intent: Intent, label: string, question?: string, answer?: string): void;
  onPage(page: number): void;
}

export function StudyView({ turn, last, busy, onAsk, onPage }: Props) {
  const { study } = turn;
  if (!study) return null;

  if (study.kind === "trail") {
    return (
      <div className="trail">
        <p className="study-intro">Learn these in order. The last one leads into your highlight.</p>
        <ol>
          {study.steps.map((step, i) => (
            <li key={i}>
              <strong>{step.idea}</strong>
              {step.why && <Answer markdown={step.why} onPage={onPage} />}
              <p className="trail-actions">
                {step.page ? (
                  <button className="cite" type="button" onClick={() => onPage(step.page!)}>See page {step.page}</button>
                ) : (
                  <span className="outside">Not covered in this paper</span>
                )}
                <button
                  className="cite"
                  type="button"
                  disabled={busy}
                  onClick={() => onAsk("question", step.idea, `Explain "${step.idea}" and how it matters for this passage.`)}
                >
                  Explain this
                </button>
              </p>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (study.kind === "quiz") {
    return (
      <div className="quiz">
        <div className="quiz-question"><Answer markdown={study.question} onPage={onPage} /></div>
        {last && <AnswerForm question={study.question} label="Check my answer" onAsk={onAsk} />}
      </div>
    );
  }

  return (
    <div className="grade">
      <blockquote className="your-answer">{turn.answer}</blockquote>
      <p className={`verdict ${study.verdict}`}>{VERDICTS[study.verdict]}</p>
      {study.feedback && <Answer markdown={study.feedback} onPage={onPage} />}
      {study.correct_idea && (
        <div>
          <h4>What the paper says</h4>
          <Answer markdown={study.correct_idea} onPage={onPage} />
        </div>
      )}
      {study.evidence.length > 0 ? (
        study.evidence.map((e, i) => (
          <p className="evidence" key={i}>
            "{e.quote}" <button className="cite" type="button" onClick={() => onPage(e.page)}>p.{e.page}</button>
          </p>
        ))
      ) : (
        <p className="small-note">This grade has no exact quote from the paper behind it, so check it yourself.</p>
      )}
      {last && study.verdict !== "correct" && <AnswerForm question={turn.question} label="Try again" onAsk={onAsk} />}
    </div>
  );
}
