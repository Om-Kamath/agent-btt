export type Intent = "explain" | "simplify" | "deepen" | "example" | "question" | "visualize" | "repair" | "prerequisites" | "quiz" | "grade";
export type Agent = "coordinator" | "librarian" | "tutor" | "illustrator" | "reviewer" | "pathfinder" | "examiner" | "grader";
// Answers saved before the app became Groq-only can name another provider.
export interface Via { provider: string; model: string }
export type Check = "passed" | "flagged" | "unchecked" | "skipped";

export interface TrailStep { idea: string; why: string; page: number | null }
export interface Evidence { page: number; quote: string }
export type Study =
  | { kind: "trail"; steps: TrailStep[] }
  | { kind: "quiz"; question: string }
  | { kind: "grade"; verdict: "correct" | "partly" | "not_yet"; feedback: string; correct_idea: string; evidence: Evidence[] };

/** Everything sent to and received from the model for one request, so the reader can inspect it. */
export interface ModelRecord {
  model: string;
  prompt: { system: string; user: string };
  output: string;
  reasoning: string;
  duration_ms: number;
  usage?: { input: number; output: number };
}

export interface GuideSection { page: number; title: string; why: string }
export interface GuideTerm { term: string; definition: string; first_page: number }
export interface Guide { claim: string; read_first: GuideSection[]; skim: GuideSection[]; terms: GuideTerm[]; record: ModelRecord | null }

export interface CitationResult {
  references: { number: number; text: string }[];
  missing: number[];
  what: string;
  why: string;
  why_error: string;
  record: ModelRecord | null;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface PageMarks { page: number; rects: Rect[] }

export interface Visual { form: "mermaid" | "html"; code: string; caption: string }
export interface Source { page: number; text: string }

export interface TracePassage { page: number; text: string; source: "highlight" | "search"; score: number | null }
export interface TracePlan { kind?: string; terms?: unknown; visual_form?: string; brief?: string }

/** One agent's turn, as reported by the server. Everything past `status` arrives when the step ends. */
export interface TraceStep {
  id: string;
  agent: Agent;
  attempt: number;
  rewrite?: boolean;
  repair_error?: string;
  render_error?: string;
  syntax_error?: string;
  status: "running" | "done" | "interrupted";
  startedAt: number;
  reasoning: string;
  outcome?: "ok" | "fallback" | "failed" | "approved" | "rejected";
  duration_ms?: number;
  model?: string;
  prompt?: { system: string; user: string };
  output?: string;
  usage?: { input: number; output: number };
  error?: string;
  plan?: TracePlan;
  query?: string;
  terms?: string[];
  passages?: TracePassage[];
  issues?: string;
  will_rewrite?: boolean;
  form?: Visual["form"];
  code?: string;
  caption?: string;
  study?: Study;
}

export interface Turn {
  id: string;
  intent: Intent;
  label: string;
  question: string;
  answer?: string;
  study?: Study | null;
  status: "working" | "done" | "error";
  trace: TraceStep[];
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

export interface Paper { id: string; name: string; pages: number; references: number[] }

export type AgentEvent =
  | { type: "step"; id: string; agent: Agent; attempt: number; rewrite?: boolean; repair_error?: string }
  | ({ type: "step_done"; id: string } & Partial<TraceStep>)
  | { type: "reasoning"; step: string; text: string }
  | { type: "token"; text: string }
  | { type: "result"; markdown: string; visual: Visual | null; check: Check; caveat: string; sources: Source[]; via: Via; study?: Study | null }
  | { type: "error"; message: string };
