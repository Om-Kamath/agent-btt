"""The multi-agent LangGraph.

    coordinator -> librarian -> tutor | illustrator -> reviewer -> END
                                     ^___ one rewrite ___|

Repairs of a visual that failed to render go straight to the illustrator and end there.

    coordinator -> librarian -> pathfinder | examiner -> END
                   librarian -> grader -> END
"""
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from . import prompts
from .mermaid_check import find_syntax_error
from .papers import PaperStore, page_number

log = logging.getLogger(__name__)

MAX_REWRITES = 1
DRAW_ATTEMPTS = 3
STUDY_ATTEMPTS = 2
VERDICTS = ("correct", "partly", "not_yet")
MAX_TRAIL_STEPS = 6
FALLBACK_ANALYSIS = {
    "kind": "concept",
    "terms": [],
    "visual_form": "diagram",
    "brief": "Help the student understand the highlighted passage.",
}
_FENCE = re.compile(r"```(mermaid|html)[ \t]*\n(.*)```", re.S)


@dataclass
class Models:
    fast: BaseChatModel
    smart: BaseChatModel
    structured: Any = None  # Replies with JSON.
    careful: Any = None  # Replies with JSON from the stronger model.

    def __post_init__(self):
        self.structured = self.fast.bind(response_format={"type": "json_object"})
        self.careful = self.smart.bind(response_format={"type": "json_object"})


class State(TypedDict, total=False):
    paper_id: str
    selection: str
    page: int
    intent: str
    question: str
    answer: str
    history: list[dict]
    repair: dict | None
    analysis: dict
    passages: list[dict]
    draft: str
    visual: dict | None
    feedback: str
    rewrites: int
    check: str  # passed | flagged | unchecked | skipped
    caveat: str
    study: dict | None  # What a study agent produced: a trail, a quiz question, or a grade.


def initial_state(paper_id, selection, page, intent, question="", history=None, repair=None, answer="") -> State:
    return State(
        paper_id=paper_id, selection=selection, page=page, intent=intent, question=question, answer=answer,
        history=history or [], repair=repair, analysis=FALLBACK_ANALYSIS, passages=[], draft="", visual=None,
        feedback="", rewrites=0, check="skipped", caveat="", study=None,
    )


def parse_json(text: str) -> dict[str, Any]:
    """Parse a model's JSON reply, tolerating a surrounding code fence."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("no JSON object in reply")
    return json.loads(match.group(0))


def parse_visual(text: str) -> dict | None:
    match = _FENCE.search(text)
    if not match:
        return None
    caption = (text[: match.start()] + text[match.end() :]).strip()
    return {"form": match.group(1), "code": match.group(2).strip(), "caption": " ".join(caption.split())}


def _paper_block(state: State) -> str:
    passages = "\n\n".join(f"[p.{p['page']}]\n{p['text']}" for p in state.get("passages", []))
    return f"<paper>\n{passages}\n</paper>" if passages else ""


def _conversation_block(state: State) -> str:
    history = state.get("history") or []
    if not history:
        return ""
    lines = "\n\n".join(f"{turn['role']}: {turn['content']}" for turn in history)
    return f"<conversation>\n{lines}\n</conversation>"


def _selection_block(state: State) -> str:
    return f"<selection page=\"{state['page']}\">\n{state['selection']}\n</selection>"


def _join(*parts: str) -> str:
    return "\n\n".join(p for p in parts if p)


def _request(state: State) -> str:
    if state["intent"] == "question":
        return f"The student asks about this passage: {state['question']}"
    return prompts.INTENTS.get(state["intent"], prompts.INTENTS["explain"])


def model_name(llm) -> str:
    """The model behind any wrapper LangChain put around it."""
    while hasattr(llm, "bound"):
        llm = llm.bound
    return getattr(llm, "model_name", None) or getattr(llm, "model", "")


def _safe_error(error: Exception) -> str:
    """What to tell the reader about a failure. Provider messages stay in the log, since they can echo request details."""
    if isinstance(error, ValueError):
        return "The reply wasn't in the expected format."
    return "The model returned an error or couldn't be reached."


class _Step:
    """One agent's turn on the record: announced when it starts, and reported in full when it ends."""

    def __init__(self, agent: str, attempt: int = 1, **details):
        self.write = get_stream_writer()
        self.started = time.monotonic()
        self.base = {"id": uuid.uuid4().hex[:12], "agent": agent, "attempt": attempt, **details}
        self.details: dict[str, Any] = {}
        self.write({"type": "step", **self.base})

    def finish(self, outcome: str = "ok", **details):
        duration_ms = int((time.monotonic() - self.started) * 1000)
        self.write({"type": "step_done", **self.base, **self.details, "outcome": outcome, "duration_ms": duration_ms, **details})

    async def ask(self, llm, system: str, user: str, on_text: Callable[[str], None] | None = None):
        """Calls the model, passing on its reasoning as it arrives and recording everything sent and received."""
        output = ""
        self.details.update(model=model_name(llm), prompt={"system": system, "user": user})
        reply = None
        try:
            async for chunk in llm.astream([SystemMessage(system), HumanMessage(user)]):
                reply = chunk if reply is None else reply + chunk
                reasoning = chunk.additional_kwargs.get("reasoning_content")
                if reasoning:
                    self.write({"type": "reasoning", "step": self.base["id"], "text": reasoning})
                if chunk.text:
                    output += chunk.text
                    if on_text:
                        on_text(chunk.text)
        finally:
            # Kept even after a failure, so the record shows how far the model got.
            self.details["output"] = output
        if reply is None:
            raise ValueError("no reply")
        if reply.usage_metadata:
            self.details["usage"] = {"input": reply.usage_metadata["input_tokens"], "output": reply.usage_metadata["output_tokens"]}
        return output


def build_graph(store: PaperStore, models: Models):
    async def coordinator(state: State) -> State:
        step = _Step("coordinator")
        user = _join(_selection_block(state), _request(state))
        try:
            data = parse_json(await step.ask(models.structured, prompts.COORDINATOR, user))
            analysis = {**FALLBACK_ANALYSIS, **data}
            step.finish(plan=analysis)
            return {"analysis": analysis}
        except Exception as error:
            # The team can still work without a plan. If Groq is truly down, the Tutor reports it.
            log.warning("Coordinator failed, using fallback: %s", error)
            step.finish("fallback", plan=FALLBACK_ANALYSIS, error=_safe_error(error))
            return {"analysis": FALLBACK_ANALYSIS}

    def librarian(state: State) -> State:
        step = _Step("librarian")
        paper = store.get(state["paper_id"])
        terms = state["analysis"].get("terms") or []
        terms = terms if isinstance(terms, list) else []
        query = " ".join([*map(str, terms), state["selection"], state["question"] if state["intent"] == "grade" else ""]).strip()
        here = paper.around(state["page"], state["selection"])
        passages = [{"page": state["page"], "text": here, "source": "highlight", "score": None}] if here else []
        for found, score in paper.ranked(query):
            if not (found.page == state["page"] and found.text[:80] in here):
                passages.append({"page": found.page, "text": found.text, "source": "search", "score": round(score, 2)})
        step.finish(query=query, terms=[str(t) for t in terms], passages=passages)
        return {"passages": passages}

    async def tutor(state: State) -> State:
        feedback = state.get("feedback")
        step = _Step("tutor", attempt=state.get("rewrites", 0) + 1, rewrite=bool(feedback))
        write = step.write
        user = _join(
            _paper_block(state), _conversation_block(state), _selection_block(state),
            f"What the student likely needs: {state['analysis'].get('brief', '')}", _request(state),
            f"A reviewer rejected your draft:\n{state['draft']}\n\nReviewer's note: {feedback}\nWrite a corrected explanation." if feedback else "",
        )
        if feedback:
            # The student is already reading the draft, so the rewrite arrives whole in the final result.
            try:
                text = await step.ask(models.smart, prompts.TUTOR, user)
                step.finish()
                return {"draft": text, "feedback": ""}
            except Exception as error:
                log.warning("Rewrite failed, keeping draft: %s", error)
                step.finish("failed", error=_safe_error(error))
                return {"check": "flagged", "caveat": feedback, "feedback": ""}
        try:
            text = await step.ask(models.smart, prompts.TUTOR, user, lambda piece: write({"type": "token", "text": piece}))
        except Exception as error:
            step.finish("failed", error=_safe_error(error))
            raise
        step.finish()
        return {"draft": text}

    async def illustrator(state: State) -> State:
        feedback, previous = state.get("feedback"), state.get("visual")
        repair = state.get("repair")
        wanted = "interactive HTML" if state["analysis"].get("visual_form") == "interactive" else "Mermaid"
        user = _join(
            _paper_block(state), _conversation_block(state), _selection_block(state),
            f"What the student likely needs: {state['analysis'].get('brief', '')}",
            f"Draw this as {wanted}. {state['question']}".strip(),
            f"A reviewer rejected your picture:\n{previous['code'] if previous else ''}\n\nReviewer's note: {feedback}\nDraw a corrected version." if feedback else "",
            f"This {repair['form']} failed to render in the browser. Fix it and keep the same idea.\n\nError: {repair['error']}\n\nCode:\n{repair['code']}" if repair else "",
        )
        details = {"rewrite": bool(feedback)}
        if repair:
            details["repair_error"] = repair["error"]
        request = user
        error: Exception | None = None
        for attempt in range(DRAW_ATTEMPTS):
            step = _Step("illustrator", attempt=state.get("rewrites", 0) + attempt + 1, **details)
            try:
                visual = parse_visual(await step.ask(models.smart, prompts.ILLUSTRATOR, request))
            except Exception as failure:
                error = failure
                step.finish("failed", error=_safe_error(failure))
                break
            error = ValueError("The team couldn't draw a visual for this passage. Try again, or ask for an explanation.")
            if not visual:
                step.finish("failed", error="The reply had no complete code block.")
                request = user + "\n\nYour last reply had no complete code block. Reply with one sentence and one fenced code block."
                continue
            syntax_error = await find_syntax_error(visual["code"]) if visual["form"] == "mermaid" else None
            if syntax_error:
                step.finish("failed", form="mermaid", code=visual["code"], syntax_error=syntax_error)
                request = (
                    f"{user}\n\nYour last diagram has a syntax error, so it can't be drawn.\n\nError: {syntax_error}\n\nDiagram:\n{visual['code']}\n\n"
                    'Fix it. Put double quotes around every label, like A["Label"], and use plain words instead of math in labels. '
                    "Reply with one sentence and one fenced code block."
                )
                continue
            step.finish(form=visual["form"], code=visual["code"], caption=visual["caption"])
            return {"visual": visual, "feedback": ""}
        if not previous or repair:
            raise error
        log.warning("Redraw failed, keeping first picture: %s", error)
        return {"check": "flagged", "caveat": feedback, "feedback": ""}

    async def reviewer(state: State) -> State:
        step = _Step("reviewer")
        visual = state.get("visual")
        work = f"Picture ({visual['form']}): {visual['caption']}\n{visual['code']}" if visual else state["draft"]
        user = _join(_paper_block(state), _selection_block(state), f"Teammate's work:\n{work}")
        try:
            data = parse_json(await step.ask(models.structured, prompts.REVIEWER, user))
        except Exception as error:
            log.warning("Reviewer failed: %s", error)
            step.finish("failed", error=_safe_error(error))
            return {"check": "unchecked"}
        if data.get("approved") is True:
            step.finish("approved")
            return {"check": "passed", "caveat": ""}
        issues = str(data.get("issues") or "The reviewer found a problem but gave no details.")
        will_rewrite = state.get("rewrites", 0) < MAX_REWRITES
        step.finish("rejected", issues=issues, will_rewrite=will_rewrite)
        if will_rewrite:
            return {"feedback": issues, "rewrites": state.get("rewrites", 0) + 1}
        return {"check": "flagged", "caveat": issues}

    async def ask_for_json(agent: str, system: str, user: str, read: Callable[[dict], dict]) -> dict:
        """One study agent's job, with a second try if the reply can't be used. A failure of the model itself ends it."""
        for attempt in range(1, STUDY_ATTEMPTS + 1):
            step = _Step(agent, attempt=attempt)
            try:
                study = read(parse_json(await step.ask(models.careful, system, user)))
            except (ValueError, TypeError, AttributeError) as error:
                log.warning("%s reply unusable: %s", agent, error)
                step.finish("failed", error=_safe_error(ValueError()))
                continue
            except Exception as error:
                step.finish("failed", error=_safe_error(error))
                raise
            step.finish(study=study)
            return {"study": study}
        raise ValueError("The team couldn't finish this. Try again.")

    async def pathfinder(state: State) -> State:
        paper = store.get(state["paper_id"])

        def read(data: dict) -> dict:
            steps = []
            for item in data["steps"][:MAX_TRAIL_STEPS] if isinstance(data.get("steps"), list) else []:
                idea = str(item.get("idea") or "").strip()
                if idea:
                    # The page is checked against the text, so "not in this paper" can be trusted.
                    steps.append({"idea": idea, "why": str(item.get("why") or "").strip(), "page": paper.locate(idea, item.get("page"))})
            if not steps:
                raise ValueError("no steps")
            return {"kind": "trail", "steps": steps}

        user = _join(_paper_block(state), _selection_block(state), f"What the student likely needs: {state['analysis'].get('brief', '')}")
        return await ask_for_json("pathfinder", prompts.PATHFINDER, user, read)

    async def examiner(state: State) -> State:
        def read(data: dict) -> dict:
            question = str(data.get("question") or "").strip()
            if not question:
                raise ValueError("no question")
            return {"kind": "quiz", "question": question}

        user = _join(_paper_block(state), _conversation_block(state), _selection_block(state))
        return await ask_for_json("examiner", prompts.EXAMINER, user, read)

    async def grader(state: State) -> State:
        paper = store.get(state["paper_id"])

        def read(data: dict) -> dict:
            verdict = data.get("verdict")
            if verdict not in VERDICTS:
                raise ValueError("no verdict")
            evidence = data.get("evidence") if isinstance(data.get("evidence"), list) else []
            # A quote that isn't in the paper can't support the grade, so only real ones are shown.
            quotes = []
            for item in evidence:
                page = page_number(item.get("page"), len(paper.pages)) if isinstance(item, dict) else None
                if page and paper.has_quote(page, str(item.get("quote") or "")):
                    quotes.append({"page": page, "quote": str(item["quote"])})
            return {"kind": "grade", "verdict": verdict, "feedback": str(data.get("feedback") or "").strip(),
                    "correct_idea": str(data.get("correct_idea") or "").strip(), "evidence": quotes}

        user = _join(
            _paper_block(state), _selection_block(state),
            f"<question>\n{state['question']}\n</question>", f"<answer>\n{state['answer']}\n</answer>",
        )
        return await ask_for_json("grader", prompts.GRADER, user, read)

    def entry(state: State) -> str:
        if state["intent"] == "repair":
            return "illustrator"
        return "librarian" if state["intent"] == "grade" else "coordinator"

    def choose_writer(state: State) -> str:
        writers = {"visualize": "illustrator", "prerequisites": "pathfinder", "quiz": "examiner", "grade": "grader"}
        return writers.get(state["intent"], "tutor")

    def after_writer(state: State) -> str:
        if state["intent"] == "repair" or state.get("check") == "flagged":
            return END
        return "reviewer"

    def after_review(state: State) -> str:
        if not state.get("feedback"):
            return END
        return choose_writer(state)

    graph = StateGraph(State)
    graph.add_node("coordinator", coordinator)
    graph.add_node("librarian", librarian)
    graph.add_node("tutor", tutor)
    graph.add_node("illustrator", illustrator)
    graph.add_node("reviewer", reviewer)
    graph.add_node("pathfinder", pathfinder)
    graph.add_node("examiner", examiner)
    graph.add_node("grader", grader)
    graph.add_conditional_edges(START, entry, ["coordinator", "librarian", "illustrator"])
    for study_agent in ("pathfinder", "examiner", "grader"):
        graph.add_edge(study_agent, END)
    graph.add_edge("coordinator", "librarian")
    graph.add_conditional_edges("librarian", choose_writer, ["tutor", "illustrator", "pathfinder", "examiner", "grader"])
    graph.add_conditional_edges("tutor", after_writer, ["reviewer", END])
    graph.add_conditional_edges("illustrator", after_writer, ["reviewer", END])
    graph.add_conditional_edges("reviewer", after_review, ["tutor", "illustrator", END])
    return graph.compile()
