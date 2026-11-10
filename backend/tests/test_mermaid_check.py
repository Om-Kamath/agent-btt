"""Broken Mermaid gets caught and redrawn on the server, before the Reviewer or the reader sees it."""
import json
import shutil
from pathlib import Path

import pytest
from langchain_groq import ChatGroq

from margin import mermaid_check
from margin.graph import Models, build_graph, initial_state
from margin.mermaid_check import find_syntax_error
from margin.papers import PaperStore

GOOD = 'flowchart LR\n  A["Query"] --> B["Scores"]'
BAD = 'flowchart TD\n  A[Dot] --> D{Divide by Scale $\\sqrt{d_k}$};\n  D --> E'
needs_node = pytest.mark.skipif(
    not (shutil.which("node") and (Path(mermaid_check.SCRIPT).parent / "node_modules" / "mermaid").is_dir()),
    reason="needs Node and the frontend's packages",
)


def drawing(code):
    return f"A picture.\n\n```mermaid\n{code}\n```"


@needs_node
@pytest.mark.parametrize("code", [
    GOOD,
    'flowchart TD\n  A["Divide by √d_k (scale)"] --> B{"softmax?"}',
    "sequenceDiagram\n  A->>B: hello",
    "stateDiagram-v2\n  [*] --> S1",
])
async def test_valid_diagrams_pass(code):
    assert await find_syntax_error(code) is None


@needs_node
async def test_the_diagram_that_failed_in_the_browser_is_caught():
    assert "Parse error" in await find_syntax_error(BAD)


async def test_without_node_the_check_steps_aside(monkeypatch):
    monkeypatch.setattr(mermaid_check, "NODE", "/nonexistent/node")
    assert await find_syntax_error(BAD) is None


async def test_a_hung_check_steps_aside(monkeypatch):
    monkeypatch.setattr(mermaid_check, "NODE", "sleep")
    monkeypatch.setattr(mermaid_check, "SCRIPT", "30")
    monkeypatch.setattr(mermaid_check, "TIMEOUT_SECONDS", 0.1)
    assert await find_syntax_error(BAD) is None


@pytest.fixture
def run(groq, groq_url, tmp_path, paper_bytes):
    store = PaperStore(tmp_path)
    store.add(paper_bytes, "a.pdf")

    def llm(model):
        return ChatGroq(model=model, api_key="test", base_url=groq_url, max_retries=0, max_tokens=500)

    graph = build_graph(store, Models(fast=llm("fast"), smart=llm("smart")))

    async def _run():
        state = initial_state(paper_id=store.ids()[0], selection="dot products", page=2, intent="visualize")
        events, final, raised = [], None, None
        try:
            async for mode, chunk in graph.astream(state, stream_mode=["custom", "values"]):
                if mode == "custom":
                    events.append(chunk)
                else:
                    final = chunk
        except ValueError as error:
            raised = error
        return events, final, raised

    return _run


@needs_node
async def test_broken_mermaid_is_redrawn_before_review(run, groq):
    groq.script("Illustrator", drawing(BAD), drawing(GOOD))
    events, final, _ = await run()
    assert [e["agent"] for e in events if e["type"] == "step"] == ["coordinator", "librarian", "illustrator", "illustrator", "reviewer"]
    assert final["visual"]["code"] == GOOD
    assert len(groq.calls("Reviewer")) == 1
    assert GOOD in groq.calls("Reviewer")[0]["messages"][-1]["content"]


@needs_node
async def test_the_redraw_is_told_what_was_wrong(run, groq):
    groq.script("Illustrator", drawing(BAD), drawing(GOOD))
    await run()
    retry = groq.calls("Illustrator")[1]["messages"][-1]["content"]
    assert "Parse error" in retry
    assert BAD in retry


@needs_node
async def test_the_failed_try_stays_on_the_record(run, groq):
    groq.script("Illustrator", drawing(BAD), drawing(GOOD))
    events, _, _ = await run()
    tries = [e for e in events if e["type"] == "step_done" and e["agent"] == "illustrator"]
    assert tries[0]["outcome"] == "failed"
    assert tries[0]["syntax_error"].startswith("Parse error")
    assert tries[0]["code"] == BAD
    assert tries[1]["outcome"] == "ok"


@needs_node
async def test_a_diagram_that_never_parses_ends_in_a_clear_error_without_review(run, groq):
    groq.script("Illustrator", drawing(BAD), drawing(BAD), drawing(BAD))
    _, _, raised = await run()
    assert "couldn't draw" in str(raised)
    assert len(groq.calls("Illustrator")) == 3
    assert groq.calls("Reviewer") == []


async def test_html_pictures_skip_the_mermaid_check(run, groq):
    groq.script("Illustrator", "A picture.\n\n```html\n<svg></svg>\n```")
    events, final, _ = await run()
    assert final["visual"]["form"] == "html"
    assert len(groq.calls("Illustrator")) == 1
