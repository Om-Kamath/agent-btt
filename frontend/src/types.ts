export type Intent = "explain" | "simplify" | "deepen" | "example" | "question" | "visualize" | "repair";
export type Agent = "coordinator" | "librarian" | "tutor" | "illustrator" | "reviewer";
export type ProviderName = "groq" | "ollama";
export interface Via { provider: ProviderName; model: string; local: boolean }
export type Check = "passed" | "flagged" | "unchecked" | "skipped";

export interface Rect { x: number; y: number; w: number; h: number }
export interface PageMarks { page: number; rects: Rect[] }

export interface Visual { form: "mermaid" | "html"; code: string; caption: string }
export interface Source { page: number; text: string }

export interface Turn {
  id: string;
  intent: Intent;
  label: string;
  question: string;
  status: "working" | "done" | "error";
  agent?: Agent;
  markdown: string;
  visual: Visual | null;
  sources: Source[];
  check: Check;
  caveat: string;
  error: string;
  repairs: number;
  via?: Via;
}

export interface Highlight {
  id: string;
  text: string;
  page: number;
  marks: PageMarks[];
  turns: Turn[];
}

export interface Paper { id: string; name: string; pages: number }

export type AgentEvent =
  | { type: "step"; agent: Agent }
  | { type: "token"; text: string }
  | { type: "result"; markdown: string; visual: Visual | null; check: Check; caveat: string; sources: Source[]; via: Via }
  | { type: "error"; message: string };
