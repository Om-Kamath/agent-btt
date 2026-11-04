import { SseParser } from "./lib";
import type { AgentEvent, Intent, Paper, ProviderName, Visual } from "./types";

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return typeof body.detail === "string" ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

export async function uploadPaper(file: File): Promise<Paper> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/papers", { method: "POST", body: form });
  if (!res.ok) throw new Error(await detail(res, "This PDF couldn't be opened."));
  return res.json();
}

export async function getPaper(id: string): Promise<Paper | null> {
  const res = await fetch(`/api/papers/${id}`);
  return res.ok ? res.json() : null;
}

export interface ProviderHealth {
  ready: boolean;
  local: boolean;
  message: string;
  model: string;
}

export interface Health {
  default: ProviderName;
  providers: Partial<Record<ProviderName, ProviderHealth>>;
}

/** Naming the active provider also tells the server to get its model ready. */
export async function getHealth(active?: ProviderName): Promise<Health | null> {
  const res = await fetch(active ? `/api/health?active=${active}` : "/api/health");
  return res.ok ? res.json() : null;
}

export const paperFileUrl = (id: string) => `/api/papers/${id}/file`;

export interface AskBody {
  selection: string;
  page: number;
  intent: Intent;
  question?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  repair?: { form: Visual["form"]; code: string; error: string };
  provider?: ProviderName;
}

export async function ask(paperId: string, body: AskBody, signal: AbortSignal, onEvent: (e: AgentEvent) => void) {
  const res = await fetch(`/api/papers/${paperId}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await detail(res, "The server couldn't answer. Try again."));
  const parser = new SseParser();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const event of parser.feed(value)) onEvent(event);
  }
}
