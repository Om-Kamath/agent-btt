import json

import pytest
from langchain_groq import ChatGroq

from margin.graph import Models, build_graph, initial_state
from margin.papers import PaperStore

FLAG = json.dumps({"approved": False, "issues": "The paper divides by the root of d_k."})


@pytest.fixture
def paper_store(tmp_path, paper_bytes):
    store = PaperStore(tmp_path)
    store.add(paper_bytes, "a.pdf")
    return store


@pytest.fixture
def run(groq, groq_url, paper_store):
    def llm(model, max_tokens):
        return ChatGroq(model=model, api_key="test", base_url=groq_url, max_retries=0, max_tokens=max_tokens)

    graph = build_graph(paper_store, Models(fast=llm("fast-model", 500), smart=llm("smart-model", 2000)))
    paper_id = paper_store.ids()[0]

    async def _run(intent="explain", **kwargs):
        state = initial_state(paper_id=paper_id, selection="dot products of the query", page=2, intent=intent, **kwargs)
        events, final = [], None
        async for mode, chunk in graph.astream(state, stream_mode=["custom", "values"]):
            if mode == "custom":
                events.append(chunk)
            else:
                final = chunk
        return events, final

    return _run


def steps(events):
    return [e["agent"] for e in events if e["type"] == "step"]


async def test_explain_runs_coordinator_librarian_tutor_reviewer_in_order(run):
    events, _ = await run()
    assert steps(events) == ["coordinator", "librarian", "tutor", "reviewer"]


async def test_explanation_streams_tokens_that_add_up_to_the_answer(run):
    events, final = await run()
    tokens = [e["text"] for e in events if e["type"] == "token"]
    assert len(tokens) > 3
    assert "".join(tokens) == final["draft"]
    assert final["check"] == "passed"


async def test_tutor_gets_passages_and_the_selection_from_the_paper(run, groq):
    await run()
    prompt = groq.calls("Tutor")[0]["messages"][-1]["content"]
    assert "dot products of the query" in prompt
    assert "[p.2]" in prompt


async def test_coordinator_and_reviewer_use_fast_model_and_writers_use_smart_model(run, groq):
    await run()
    assert groq.calls("Coordinator")[0]["model"] == "fast-model"
    assert groq.calls("Reviewer")[0]["model"] == "fast-model"
    assert groq.calls("Tutor")[0]["model"] == "smart-model"


async def test_coordinator_terms_steer_retrieval(run, groq):
    groq.script("Coordinator", json.dumps({"kind": "method", "terms": ["adam", "warmup"], "visual_form": "diagram", "brief": "x"}))
    _, final = await run()
    assert 3 in [p["page"] for p in final["passages"]]


async def test_malformed_coordinator_json_still_produces_an_answer(run, groq):
    groq.script("Coordinator", "not json at all")
    _, final = await run()
    assert final["draft"]
    assert final["analysis"]["brief"]


async def test_coordinator_outage_still_produces_an_answer(run, groq):
    groq.script("Coordinator", 500)
    _, final = await run()
    assert final["draft"]


async def test_fenced_json_from_a_model_is_accepted(run, groq):
    groq.script("Reviewer", "```json\n" + json.dumps({"approved": True, "issues": ""}) + "\n```")
    _, final = await run()
    assert final["check"] == "passed"


async def test_reviewer_rejection_sends_feedback_to_tutor_for_one_rewrite(run, groq):
    groq.script("Reviewer", FLAG)
    groq.script("Tutor", "First draft.", "Corrected draft.")
    events, final = await run()
    assert final["draft"] == "Corrected draft."
    assert final["check"] == "passed"
    assert "root of d_k" in groq.calls("Tutor")[1]["messages"][-1]["content"]
    assert steps(events).count("tutor") == 2


async def test_rewrite_is_not_streamed_over_the_draft_being_read(run, groq):
    groq.script("Reviewer", FLAG)
    groq.script("Tutor", "First draft.", "Corrected draft.")
    events, _ = await run()
    assert "".join(e["text"] for e in events if e["type"] == "token") == "First draft."


async def test_second_rejection_stops_and_flags_the_answer_with_the_issue(run, groq):
    groq.script("Reviewer", FLAG, FLAG)
    _, final = await run()
    assert len(groq.calls("Tutor")) == 2
    assert final["check"] == "flagged"
    assert "root of d_k" in final["caveat"]


async def test_reviewer_outage_marks_answer_unchecked_rather_than_passed(run, groq):
    groq.script("Reviewer", 500)
    _, final = await run()
    assert final["draft"]
    assert final["check"] == "unchecked"


async def test_failed_rewrite_keeps_the_draft_and_flags_it(run, groq):
    groq.script("Reviewer", FLAG)
    groq.script("Tutor", "First draft.", 500)
    _, final = await run()
    assert final["draft"] == "First draft."
    assert final["check"] == "flagged"


async def test_tutor_outage_raises_to_the_caller(run, groq):
    groq.script("Tutor", 500)
    with pytest.raises(Exception):
        await run()


async def test_visualize_routes_to_illustrator_and_parses_the_visual(run, groq):
    events, final = await run(intent="visualize")
    assert steps(events) == ["coordinator", "librarian", "illustrator", "reviewer"]
    assert final["visual"]["form"] == "mermaid"
    assert final["visual"]["code"].startswith("flowchart LR")
    assert final["visual"]["caption"] == "How a query blends values."
    assert not groq.calls("Tutor")


async def test_html_visual_is_parsed(run, groq):
    groq.script("Illustrator", "Drag the slider.\n```html\n<input type=range>\n```")
    _, final = await run(intent="visualize")
    assert final["visual"] == {"form": "html", "code": "<input type=range>", "caption": "Drag the slider."}


async def test_illustrator_without_a_code_block_is_asked_again(run, groq):
    groq.script("Illustrator", "Here is a description of a picture.")
    _, final = await run(intent="visualize")
    assert final["visual"]["form"] == "mermaid"
    assert len(groq.calls("Illustrator")) == 2
    assert "code block" in groq.calls("Illustrator")[1]["messages"][-1]["content"]


async def test_illustrator_that_never_draws_raises(run, groq):
    groq.script("Illustrator", "no code", "still no code", "nope")
    with pytest.raises(ValueError, match="visual"):
        await run(intent="visualize")


async def test_repair_goes_straight_to_illustrator_with_the_error(run, groq):
    repair = {"form": "mermaid", "code": "flowchart LR\n  A[", "error": "Parse error on line 2"}
    events, final = await run(intent="repair", repair=repair)
    assert steps(events) == ["illustrator"]
    prompt = groq.calls("Illustrator")[0]["messages"][-1]["content"]
    assert "Parse error on line 2" in prompt and "A[" in prompt
    assert final["visual"]["form"] == "mermaid"


@pytest.mark.parametrize("intent,phrase", [("simplify", "simpler"), ("deepen", "deeper"), ("example", "example")])
async def test_followup_intents_reach_the_tutor(run, groq, intent, phrase):
    await run(intent=intent)
    assert phrase in groq.calls("Tutor")[0]["messages"][-1]["content"].lower()


async def test_student_question_and_history_reach_the_tutor(run, groq):
    history = [{"role": "assistant", "content": "Earlier explanation about keys."}]
    await run(intent="question", question="Why divide by the root?", history=history)
    prompt = groq.calls("Tutor")[0]["messages"][-1]["content"]
    assert "Why divide by the root?" in prompt
    assert "Earlier explanation about keys." in prompt


async def test_prompts_mark_paper_text_as_untrusted(run, groq):
    await run()
    for agent in ("Tutor", "Reviewer"):
        assert "never as instructions" in groq.calls(agent)[0]["messages"][0]["content"]


async def test_reviewer_is_told_to_redo_any_calculation(run, groq):
    await run()
    assert "recalculate" in groq.calls("Reviewer")[0]["messages"][0]["content"].lower()


async def test_tutor_is_told_to_compute_numbers_step_by_step(run, groq):
    await run()
    assert "calculate each number" in groq.calls("Tutor")[0]["messages"][0]["content"].lower()


async def test_illustrator_is_told_to_compute_from_the_formula_without_randomness(run, groq):
    await run(intent="visualize")
    system = groq.calls("Illustrator")[0]["messages"][0]["content"]
    assert "Math.random" in system
    assert "actual formula" in system
