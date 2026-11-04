"""The multi-agent LangGraph.

    coordinator -> librarian -> tutor | illustrator -> reviewer -> END
                                     ^___ one rewrite ___|

Repairs of a visual that failed to render go straight to the illustrator and end there.
"""
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from . import prompts
from .papers import PaperStore

log = logging.getLogger(__name__)

MAX_REWRITES = 1
DRAW_ATTEMPTS = 2
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
    structured: Any = None  # Replies with JSON. Defaults to the fast model in OpenAI-style JSON mode.
    reviewer: Any = None  # Replies with JSON after careful checking. Defaults to structured.
    illustrator: Any = None  # Writes code for visuals. Defaults to smart.

    def __post_init__(self):
        if self.structured is None:
            self.structured = self.fast.bind(response_format={"type": "json_object"})
        self.reviewer = self.reviewer or self.structured
        self.illustrator = self.illustrator or self.smart


class State(TypedDict, total=False):
    paper_id: str
    selection: str
    page: int
    intent: str
    question: str
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


def initial_state(paper_id, selection, page, intent, question="", history=None, repair=None) -> State:
    return State(
        paper_id=paper_id, selection=selection, page=page, intent=intent, question=question,
        history=history or [], repair=repair, analysis=FALLBACK_ANALYSIS, passages=[], draft="", visual=None,
        feedback="", rewrites=0, check="skipped", caveat="",
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


def build_graph(store: PaperStore, models: Models):
    async def ask_json(llm, system: str, user: str) -> dict[str, Any]:
        reply = await llm.ainvoke([SystemMessage(system), HumanMessage(user)])
        return parse_json(reply.text)

    async def coordinator(state: State) -> State:
        get_stream_writer()({"type": "step", "agent": "coordinator"})
        user = _join(_selection_block(state), _request(state))
        try:
            data = await ask_json(models.structured, prompts.COORDINATOR, user)
            return {"analysis": {**FALLBACK_ANALYSIS, **data}}
        except Exception as error:
            # The team can still work without a plan. If Groq is truly down, the Tutor reports it.
            log.warning("Coordinator failed, using fallback: %s", error)
            return {"analysis": FALLBACK_ANALYSIS}

    def librarian(state: State) -> State:
        get_stream_writer()({"type": "step", "agent": "librarian"})
        paper = store.get(state["paper_id"])
        terms = state["analysis"].get("terms") or []
        terms = terms if isinstance(terms, list) else []
        query = " ".join([*map(str, terms), state["selection"]])
        here = paper.around(state["page"], state["selection"])
        passages = [{"page": state["page"], "text": here}] if here else []
        for found in paper.search(query):
            if not (found.page == state["page"] and found.text[:80] in here):
                passages.append({"page": found.page, "text": found.text})
        return {"passages": passages}

    async def tutor(state: State) -> State:
        write = get_stream_writer()
        write({"type": "step", "agent": "tutor"})
        feedback = state.get("feedback")
        user = _join(
            _paper_block(state), _conversation_block(state), _selection_block(state),
            f"What the student likely needs: {state['analysis'].get('brief', '')}", _request(state),
            f"A reviewer rejected your draft:\n{state['draft']}\n\nReviewer's note: {feedback}\nWrite a corrected explanation." if feedback else "",
        )
        messages = [SystemMessage(prompts.TUTOR), HumanMessage(user)]
        if feedback:
            # The student is already reading the draft, so the rewrite arrives whole in the final result.
            try:
                reply = await models.smart.ainvoke(messages)
                return {"draft": reply.text, "feedback": ""}
            except Exception as error:
                log.warning("Rewrite failed, keeping draft: %s", error)
                return {"check": "flagged", "caveat": feedback, "feedback": ""}
        text = ""
        async for chunk in models.smart.astream(messages):
            if chunk.text:
                text += chunk.text
                write({"type": "token", "text": chunk.text})
        return {"draft": text}

    async def illustrator(state: State) -> State:
        get_stream_writer()({"type": "step", "agent": "illustrator"})
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
        messages = [SystemMessage(prompts.ILLUSTRATOR), HumanMessage(user)]
        try:
            for _ in range(DRAW_ATTEMPTS):
                reply = await models.illustrator.ainvoke(messages)
                visual = parse_visual(reply.text)
                if visual:
                    return {"visual": visual, "feedback": ""}
                messages[-1] = HumanMessage(user + "\n\nYour last reply had no complete code block. Reply with one sentence and one fenced code block.")
            raise ValueError("The team couldn't draw a visual for this passage. Try again, or ask for an explanation.")
        except Exception as error:
            if not previous or repair:
                raise
            log.warning("Redraw failed, keeping first picture: %s", error)
            return {"check": "flagged", "caveat": feedback, "feedback": ""}

    async def reviewer(state: State) -> State:
        get_stream_writer()({"type": "step", "agent": "reviewer"})
        visual = state.get("visual")
        work = f"Picture ({visual['form']}): {visual['caption']}\n{visual['code']}" if visual else state["draft"]
        user = _join(_paper_block(state), _selection_block(state), f"Teammate's work:\n{work}")
        try:
            data = await ask_json(models.reviewer, prompts.REVIEWER, user)
        except Exception as error:
            log.warning("Reviewer failed: %s", error)
            return {"check": "unchecked"}
        if data.get("approved") is True:
            return {"check": "passed", "caveat": ""}
        issues = str(data.get("issues") or "The reviewer found a problem but gave no details.")
        if state.get("rewrites", 0) < MAX_REWRITES:
            return {"feedback": issues, "rewrites": state.get("rewrites", 0) + 1}
        return {"check": "flagged", "caveat": issues}

    def entry(state: State) -> str:
        return "illustrator" if state["intent"] == "repair" else "coordinator"

    def choose_writer(state: State) -> str:
        return "illustrator" if state["intent"] == "visualize" else "tutor"

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
    graph.add_conditional_edges(START, entry, ["coordinator", "illustrator"])
    graph.add_edge("coordinator", "librarian")
    graph.add_conditional_edges("librarian", choose_writer, ["tutor", "illustrator"])
    graph.add_conditional_edges("tutor", after_writer, ["reviewer", END])
    graph.add_conditional_edges("illustrator", after_writer, ["reviewer", END])
    graph.add_conditional_edges("reviewer", after_review, ["tutor", "illustrator", END])
    return graph.compile()
