"""Choosing between Groq and Ollama per request, without ever reaching the cloud by accident."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from margin.api import create_app


def make_client(tmp_path, url, **kwargs):
    options = {"provider": "ollama", "ollama_url": url, "base_url": url, "api_key": "test", "max_retries": 0, **kwargs}
    return TestClient(create_app(data_dir=tmp_path, **options))


@pytest.fixture
def client(tmp_path, groq, groq_url):
    return make_client(tmp_path, groq_url)


@pytest.fixture
def paper_id(client, paper_bytes):
    return client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]


def ask(client, paper_id, **body):
    payload = {"selection": "dot products of the query", "page": 2, "intent": "explain", **body}
    with client.stream("POST", f"/api/papers/{paper_id}/ask", json=payload) as res:
        assert res.status_code == 200
        return [json.loads(line[6:]) for line in res.iter_lines() if line.startswith("data: ")]


def apis(groq):
    return {r["api"] for r in groq.requests}


def test_no_choice_uses_the_configured_default_and_never_groq(client, paper_id, groq):
    ask(client, paper_id)
    assert apis(groq) == {"ollama"}


def test_choosing_groq_sends_that_request_to_groq_only(client, paper_id, groq):
    ask(client, paper_id, provider="groq")
    assert apis(groq) == {"groq"}


def test_the_choice_lasts_only_for_its_own_request(client, paper_id, groq):
    ask(client, paper_id, provider="groq")
    groq.requests.clear()
    ask(client, paper_id)
    assert apis(groq) == {"ollama"}


def test_choosing_ollama_works_when_groq_is_the_default(tmp_path, groq, groq_url, paper_bytes):
    client = make_client(tmp_path, groq_url, provider="groq")
    pid = client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]
    ask(client, pid, provider="ollama")
    assert apis(groq) == {"ollama"}


def test_an_ollama_failure_never_falls_back_to_groq(client, paper_id, groq):
    groq.script("Tutor", 500)
    events = ask(client, paper_id, provider="ollama")
    assert events[-1]["type"] == "error"
    assert apis(groq) == {"ollama"}


def test_each_answer_records_which_model_wrote_it(client, paper_id):
    assert ask(client, paper_id, provider="ollama")[-1]["via"] == {"provider": "ollama", "model": "gemma4:e4b", "local": True}
    assert ask(client, paper_id, provider="groq")[-1]["via"] == {"provider": "groq", "model": "openai/gpt-oss-120b", "local": False}


def test_an_unknown_provider_is_rejected(client, paper_id):
    res = client.post(f"/api/papers/{paper_id}/ask", json={"selection": "x", "page": 1, "intent": "explain", "provider": "openai"})
    assert res.status_code == 422


def test_choosing_groq_without_a_key_says_how_to_add_one(tmp_path, groq, groq_url, paper_bytes):
    client = make_client(tmp_path, groq_url, api_key="")
    pid = client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]
    assert "GROQ_API_KEY" in ask(client, pid, provider="groq")[-1]["message"]
    assert not groq.requests


def test_health_lists_both_and_the_default(client):
    health = client.get("/api/health").json()
    assert health["default"] == "ollama"
    assert set(health["providers"]) == {"groq", "ollama"}


def test_turning_cloud_off_removes_groq_and_refuses_requests_even_with_a_key(tmp_path, groq, groq_url, paper_bytes):
    client = make_client(tmp_path, groq_url, allow_cloud=False)
    assert set(client.get("/api/health").json()["providers"]) == {"ollama"}
    pid = client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]
    res = client.post(f"/api/papers/{pid}/ask", json={"selection": "x", "page": 1, "intent": "explain", "provider": "groq"})
    assert res.status_code == 403
    assert not groq.requests


def test_cloud_can_be_turned_off_from_the_environment(tmp_path, groq, groq_url, monkeypatch):
    monkeypatch.setenv("ALLOW_CLOUD", "false")
    assert set(make_client(tmp_path, groq_url).get("/api/health").json()["providers"]) == {"ollama"}


def test_defaulting_to_groq_with_cloud_off_stops_startup(tmp_path, groq_url):
    with pytest.raises(ValueError, match="ALLOW_CLOUD"):
        make_client(tmp_path, groq_url, provider="groq", allow_cloud=False)


def test_model_is_not_loaded_while_groq_is_active(tmp_path, groq, groq_url):
    with make_client(tmp_path, groq_url, provider="groq") as client:
        client.get("/api/health")
        time.sleep(0.05)
    assert not groq.loads


def test_switching_to_ollama_loads_the_model(tmp_path, groq, groq_url):
    with make_client(tmp_path, groq_url, provider="groq") as client:
        client.get("/api/health", params={"active": "ollama"})
        deadline = time.time() + 2
        while time.time() < deadline and not groq.loads:
            time.sleep(0.01)
    assert groq.loads
