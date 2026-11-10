"""The step-by-step record the reader sees: what each agent received, decided, and returned."""
import json

import pytest
from langchain_groq import ChatGroq

from margin.graph import Models, build_graph, initial_state
from margin.papers import PaperStore

REJECT = {"content": json.dumps({"approved": False, "issues": "The paper divides by the root of d_k."}),
          "reasoning": "Checking the division against page 2."}


@pytest.fixture
def store(tmp_path, paper_bytes):
    store = PaperStore(tmp_path)
    store.add(paper_bytes, "a.pdf")
    return store


async def collect(graph, store, intent="explain", **kwargs):
    state = initial_state(paper_id=store.ids()[0], selection="dot products of the query", page=2, intent=intent, **kwargs)
    events = []
    try:
        async for mode, chunk in graph.astream(state, stream_mode=["custom", "values"]):
            if mode == "custom":
                events.append(chunk)
    except Exception as error:
        events.append({"type": "raised", "error": error})
    return events


@pytest.fixture
def run(groq, groq_url, store):
    def llm(model, max_tokens):
        return ChatGroq(model=model, api_key="test", base_url=groq_url, max_retries=0, max_tokens=max_tokens)

    graph = build_graph(store, Models(fast=llm("fast-model", 500), smart=llm("smart-model", 2000)))

    async def _run(intent="explain", **kwargs):
        return await collect(graph, store, intent, **kwargs)

    return _run


def done(events, agent):
    return [e for e in events if e["type"] == "step_done" and e["agent"] == agent]


async def test_every_step_that_starts_also_finishes_with_a_time(run):
    events = await run()
    started = [e["id"] for e in events if e["type"] == "step"]
    finished = [e for e in events if e["type"] == "step_done"]
    assert len(started) == 4 and len(set(started)) == 4
    assert [e["id"] for e in finished] == started
    assert all(isinstance(e["duration_ms"], int) and e["duration_ms"] >= 0 for e in finished)


async def test_coordinator_shows_its_plan_prompt_and_reply(run, groq):
    events = await run()
    step = done(events, "coordinator")[0]
    assert step["outcome"] == "ok"
    assert step["plan"]["terms"] == ["attention", "query"]
    assert step["model"] == "fast-model"
    sent = groq.calls("Coordinator")[0]["messages"]
    assert step["prompt"] == {"system": sent[0]["content"], "user": sent[1]["content"]}
    assert json.loads(step["output"])["brief"] == "Explain the idea."


async def test_librarian_shows_what_it_searched_for_and_every_passage_used(run, groq):
    events = await run()
    step = done(events, "librarian")[0]
    assert "attention" in step["query"] and "query" in step["query"]
    assert "model" not in step
    assert step["passages"][0]["source"] == "highlight"
    assert any(p["source"] == "search" and p["score"] > 0 for p in step["passages"])
    tutor_prompt = groq.calls("Tutor")[0]["messages"][-1]["content"]
    assert all(p["text"] in tutor_prompt for p in step["passages"])


async def test_reasoning_streams_live_and_is_tied_to_its_step(run, groq):
    groq.script("Tutor", {"content": "An answer [p.2].", "reasoning": "The reader needs the idea first."})
    events = await run()
    step = done(events, "tutor")[0]
    live = [e for e in events if e["type"] == "reasoning"]
    assert "".join(e["text"] for e in live) == "The reader needs the idea first."
    assert all(e["step"] == step["id"] for e in live)
    assert events.index(live[0]) < events.index(step)
    answer = "".join(e["text"] for e in events if e["type"] == "token")
    assert "reader needs" not in answer


async def test_a_step_reports_tokens_used(run):
    events = await run()
    assert done(events, "tutor")[0]["usage"]["input"] == 11
    assert done(events, "tutor")[0]["usage"]["output"] == 7


async def test_a_rejected_draft_stays_on_the_record_with_the_reason(run, groq):
    groq.script("Tutor", "First draft is wrong.", "Corrected draft.")
    groq.script("Reviewer", REJECT, json.dumps({"approved": True, "issues": ""}))
    events = await run()
    tutors, reviews = done(events, "tutor"), done(events, "reviewer")
    assert [t["attempt"] for t in tutors] == [1, 2]
    assert tutors[0]["output"] == "First draft is wrong."
    assert tutors[1]["output"] == "Corrected draft."
    assert reviews[0]["outcome"] == "rejected"
    assert reviews[0]["issues"] == "The paper divides by the root of d_k."
    assert reviews[0]["will_rewrite"] is True
    assert reviews[1]["outcome"] == "approved"


async def test_a_problem_left_after_the_rewrite_says_no_more_rewrites(run, groq):
    groq.script("Reviewer", REJECT, REJECT)
    events = await run()
    assert [r["will_rewrite"] for r in done(events, "reviewer")] == [True, False]


async def test_a_coordinator_failure_is_shown_as_a_fallback_without_raw_error_text(run, groq):
    groq.script("Coordinator", "not json at all")
    events = await run()
    step = done(events, "coordinator")[0]
    assert step["outcome"] == "fallback"
    assert step["error"] == "The reply wasn't in the expected format."
    assert step["plan"]["brief"].startswith("Help the student")
    assert step["output"] == "not json at all"


async def test_an_unreadable_review_is_shown_as_failed(run, groq):
    groq.script("Reviewer", "not json")
    events = await run()
    step = done(events, "reviewer")[0]
    assert step["outcome"] == "failed"
    assert step["error"] == "The reply wasn't in the expected format."


async def test_a_provider_failure_never_exposes_its_message(run, groq):
    groq.script("Reviewer", 500)
    events = await run()
    step = done(events, "reviewer")[0]
    assert step["outcome"] == "failed"
    assert "scripted failure" not in json.dumps(step)


async def test_a_step_that_stops_the_run_still_finishes_on_the_record(run, groq):
    groq.script("Tutor", 500)
    events = await run()
    step = done(events, "tutor")[0]
    assert step["outcome"] == "failed"
    assert events[-1]["type"] == "raised"


async def test_each_drawing_try_is_its_own_step(run, groq):
    groq.script("Illustrator", "No code block here.")
    events = await run("visualize")
    tries = done(events, "illustrator")
    assert [t["attempt"] for t in tries] == [1, 2]
    assert tries[0]["outcome"] == "failed"
    assert tries[0]["output"] == "No code block here."
    assert tries[1]["outcome"] == "ok"
    assert tries[1]["form"] == "mermaid"


async def test_a_repair_shows_the_browser_error_that_caused_it(run):
    repair = {"form": "mermaid", "code": "flowchart LR\n  A[", "error": "Parse error on line 2"}
    events = await run("repair", repair=repair)
    step = done(events, "illustrator")[0]
    assert step["repair_error"] == "Parse error on line 2"
    assert done(events, "reviewer") == []
