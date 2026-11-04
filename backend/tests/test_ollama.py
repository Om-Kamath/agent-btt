import json
import os
import socket
import time

import pytest
from fastapi.testclient import TestClient

from margin.api import create_app


def make_client(tmp_path, url, **kwargs):
    options = {"provider": "ollama", "ollama_url": url, "api_key": "", **kwargs}
    return TestClient(create_app(data_dir=tmp_path, **options))


@pytest.fixture
def client(tmp_path, groq, groq_url):
    return make_client(tmp_path, groq_url)


def ollama_health(client):
    return client.get("/api/health").json()["providers"]["ollama"]


def upload(client, paper_bytes):
    return client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]


def ask(client, paper_id, intent="explain"):
    payload = {"selection": "dot products of the query", "page": 2, "intent": intent}
    with client.stream("POST", f"/api/papers/{paper_id}/ask", json=payload) as res:
        return [json.loads(line[6:]) for line in res.iter_lines() if line.startswith("data: ")]


def test_explanation_streams_with_no_groq_key_and_no_groq_calls(client, paper_bytes, groq):
    events = ask(client, upload(client, paper_bytes))
    assert "token" in [e["type"] for e in events]
    assert events[-1]["type"] == "result" and events[-1]["check"] == "passed"
    assert groq.requests and all(r["api"] == "ollama" for r in groq.requests)


def test_a_groq_key_in_the_environment_is_never_used(tmp_path, groq, groq_url, paper_bytes):
    client = make_client(tmp_path, groq_url, api_key="would-leak")
    ask(client, upload(client, paper_bytes))
    assert all(r["api"] == "ollama" for r in groq.requests)


def test_visual_works_locally(client, paper_bytes):
    assert ask(client, upload(client, paper_bytes), "visualize")[-1]["visual"]["form"] == "mermaid"


def test_only_coordinator_and_reviewer_ask_for_json(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes))
    assert groq.calls("Coordinator")[0]["format"] == "json"
    assert groq.calls("Reviewer")[0]["format"] == "json"
    assert groq.calls("Tutor")[0]["format"] in (None, "")


def test_context_window_is_set_because_ollamas_default_silently_truncates(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes))
    for request in groq.requests:
        assert request["options"]["num_ctx"] >= 8192
        assert request["options"]["num_predict"] > 0


def test_same_model_serves_every_agent_by_default_to_avoid_swapping_on_low_memory(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes))
    assert {r["model"] for r in groq.requests} == {"gemma4:e4b"}


def test_model_can_be_chosen(tmp_path, groq, groq_url, paper_bytes):
    groq.installed.append("gemma4:12b")
    client = make_client(tmp_path, groq_url, ollama_model="gemma4:12b")
    ask(client, upload(client, paper_bytes))
    assert {r["model"] for r in groq.requests} == {"gemma4:12b"}


def test_health_is_ready_and_local_when_the_model_is_installed(client):
    assert ollama_health(client) == {"ready": True, "local": True, "message": "", "model": "gemma4:e4b"}


def test_health_explains_how_to_install_a_missing_model(tmp_path, groq, groq_url):
    health = ollama_health(make_client(tmp_path, groq_url, ollama_model="gemma4:12b"))
    assert health["ready"] is False
    assert "ollama pull gemma4:12b" in health["message"]


def closed_port_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{s.getsockname()[1]}"


def test_health_explains_when_ollama_is_not_running(tmp_path):
    health = ollama_health(make_client(tmp_path, closed_port_url()))
    assert health["ready"] is False
    assert "Open Ollama" in health["message"]


def test_asking_while_ollama_is_off_gives_a_readable_error(tmp_path, paper_bytes):
    client = make_client(tmp_path, closed_port_url())
    assert "Open Ollama" in ask(client, upload(client, paper_bytes))[-1]["message"]


def test_asking_for_a_missing_model_says_how_to_install_it(tmp_path, groq, groq_url, paper_bytes):
    client = make_client(tmp_path, groq_url, ollama_model="gemma4:12b")
    assert "ollama pull gemma4:12b" in ask(client, upload(client, paper_bytes))[-1]["message"]


@pytest.mark.parametrize("model", ["deepseek-v3.1:671b-cloud", "qwen3-vl:235b-cloud", "some-model:cloud"])
def test_cloud_models_are_refused_because_they_send_papers_off_this_machine(tmp_path, model):
    with pytest.raises(ValueError, match="cloud"):
        make_client(tmp_path, "http://127.0.0.1:11434", ollama_model=model)


def test_an_unknown_provider_stops_startup_rather_than_falling_back(tmp_path):
    with pytest.raises(ValueError, match="LLM_PROVIDER"):
        TestClient(create_app(data_dir=tmp_path, provider="olama", api_key="would-leak"))


def test_remote_ollama_is_not_described_as_local(tmp_path, groq):
    assert ollama_health(make_client(tmp_path, "http://192.168.1.20:9"))["local"] is False


def test_langsmith_tracing_is_turned_off(tmp_path, groq, groq_url, monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    make_client(tmp_path, groq_url)
    assert os.environ["LANGSMITH_TRACING"] == "false"
    assert os.environ["LANGCHAIN_TRACING_V2"] == "false"


def test_thinking_is_off_where_it_only_costs_time(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes))
    assert groq.calls("Coordinator")[0]["think"] is False
    assert groq.calls("Tutor")[0]["think"] is False


def test_reviewer_keeps_thinking_because_without_it_correct_answers_get_rejected(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes))
    assert groq.calls("Reviewer")[0]["think"] is not False
    assert groq.calls("Reviewer")[0]["format"] == "json"


def test_illustrator_keeps_thinking_because_it_writes_code(client, paper_bytes, groq):
    ask(client, upload(client, paper_bytes), "visualize")
    assert groq.calls("Illustrator")[0]["think"] is not False


def wait_for(condition):
    deadline = time.time() + 2
    while time.time() < deadline and not condition():
        time.sleep(0.01)
    return condition()


def test_opening_the_page_loads_the_model_once_with_the_settings_used_to_answer(tmp_path, groq, groq_url):
    with make_client(tmp_path, groq_url) as client:
        client.get("/api/health")
        assert wait_for(lambda: groq.loads)
        client.get("/api/health")
        time.sleep(0.05)
    assert len(groq.loads) == 1
    # A different context size would make Ollama reload the model for the first question.
    assert groq.loads[0]["options"]["num_ctx"] >= 8192
    assert groq.loads[0]["model"] == "gemma4:e4b"
    assert groq.loads[0]["keep_alive"] == "30m"


def test_a_model_that_is_not_installed_is_not_loaded(tmp_path, groq, groq_url):
    with make_client(tmp_path, groq_url, ollama_model="gemma4:12b") as client:
        client.get("/api/health")
        time.sleep(0.05)
    assert not groq.loads
