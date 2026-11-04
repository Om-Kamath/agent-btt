import { useEffect, useRef } from "react";
import type { ProviderHealth } from "./api";
import type { ProviderName } from "./types";

interface SwitchProps {
  providers: Partial<Record<ProviderName, ProviderHealth>>;
  active: ProviderName;
  onChoose(next: ProviderName): void;
}

export function ProviderSwitch({ providers, active, onChoose }: SwitchProps) {
  const ollama = providers.ollama;
  const groq = providers.groq;
  const ollamaLabel = ollama?.local ? "This computer" : "Ollama";

  // With the cloud turned off there's nothing to choose, so this only says where answers come from.
  if (!groq) {
    return (
      <span className="where" title={`Using ${ollama?.model} through Ollama`}>
        {ollama?.local ? "Running on this computer" : "Running on your Ollama server"}
      </span>
    );
  }

  return (
    <span className="segments" role="group" aria-label="Where answers are written">
      <button type="button" aria-pressed={active === "ollama"} title={`Use ${ollama?.model} through Ollama`} onClick={() => onChoose("ollama")}>
        {ollamaLabel}
      </button>
      <button type="button" aria-pressed={active === "groq"} title={`Use ${groq.model} on Groq`} onClick={() => onChoose("groq")}>
        Groq
      </button>
    </span>
  );
}

export function ConfirmCloud({ onConfirm, onCancel }: { onConfirm(): void; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="confirm"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-title">Send this paper's text to Groq?</h2>
      <p>New questions will send passages from your paper, your highlights, and your questions to Groq's servers.</p>
      <p>Answers will be faster. The app returns to your usual setting the next time it opens.</p>
      <div className="confirm-actions">
        <button className="chip" type="button" autoFocus onClick={onCancel}>
          Stay on this computer
        </button>
        <button className="primary" type="button" onClick={onConfirm}>
          Use Groq
        </button>
      </div>
    </dialog>
  );
}
