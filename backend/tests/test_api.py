import json

import pytest
from fastapi.testclient import TestClient

from margin.api import create_app


@pytest.fixture
def client(tmp_path, groq, groq_url):
    return TestClient(create_app(data_dir=tmp_path, api_key="test", base_url=groq_url, max_retries=0, ollama_url=groq_url))


@pytest.fixture
def paper_id(client, paper_bytes):
    res = client.post("/api/papers", files={"file": ("attention.pdf", paper_bytes, "application/pdf")})
    assert res.status_code == 200
    return res.json()["id"]


def ask(client, paper_id, **body):
    payload = {"selection": "dot products of the query", "page": 2, "intent": "explain", **body}
    with client.stream("POST", f"/api/papers/{paper_id}/ask", json=payload) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        return [json.loads(line[6:]) for line in res.iter_lines() if line.startswith("data: ")]


def test_health_reports_whether_groq_is_ready(tmp_path, client, groq_url):
    health = client.get("/api/health").json()
    assert health["default"] == "groq"
    assert health["providers"]["groq"]["ready"] is True and health["providers"]["groq"]["local"] is False
    keyless = TestClient(create_app(data_dir=tmp_path, api_key="", ollama_url=groq_url)).get("/api/health").json()
    assert keyless["providers"]["groq"]["ready"] is False
    assert "GROQ_API_KEY" in keyless["providers"]["groq"]["message"]


def test_upload_returns_metadata_and_the_pdf_can_be_fetched(client, paper_bytes):
    meta = client.post("/api/papers", files={"file": ("attention.pdf", paper_bytes, "application/pdf")}).json()
    assert meta["name"] == "attention.pdf" and meta["pages"] == 4
    assert client.get(f"/api/papers/{meta['id']}").json() == meta
    pdf = client.get(f"/api/papers/{meta['id']}/file")
    assert pdf.content == paper_bytes
    assert pdf.headers["content-type"] == "application/pdf"


def test_non_pdf_upload_gets_a_readable_400(client):
    res = client.post("/api/papers", files={"file": ("x.pdf", b"nope", "application/pdf")})
    assert res.status_code == 400
    assert "isn't a PDF" in res.json()["detail"]


def test_oversized_upload_is_rejected(tmp_path, groq_url):
    client = TestClient(create_app(data_dir=tmp_path, api_key="t", base_url=groq_url, max_upload_bytes=10))
    res = client.post("/api/papers", files={"file": ("x.pdf", b"%PDF-" + b"0" * 50, "application/pdf")})
    assert res.status_code == 413


def test_unknown_paper_is_404(client):
    assert client.get("/api/papers/deadbeef").status_code == 404
    assert client.get("/api/papers/deadbeef/file").status_code == 404
    assert client.post("/api/papers/deadbeef/ask", json={"selection": "x", "page": 1, "intent": "explain"}).status_code == 404


def test_ask_streams_steps_tokens_then_a_result_with_citable_sources(client, paper_id):
    events = ask(client, paper_id)
    types = [e["type"] for e in events]
    assert types[0] == "step"
    assert "token" in types
    assert types[-1] == "result"
    result = events[-1]
    assert result["markdown"].startswith("Attention lets")
    assert result["check"] == "passed"
    assert result["visual"] is None
    assert 2 in [s["page"] for s in result["sources"]]


def test_visual_result_carries_the_visual(client, paper_id):
    result = ask(client, paper_id, intent="visualize")[-1]
    assert result["visual"]["form"] == "mermaid"


def test_ask_without_a_key_explains_how_to_add_one(tmp_path, paper_bytes):
    client = TestClient(create_app(data_dir=tmp_path, api_key=""))
    pid = client.post("/api/papers", files={"file": ("a.pdf", paper_bytes, "application/pdf")}).json()["id"]
    events = ask(client, pid)
    assert events[-1]["type"] == "error"
    assert "GROQ_API_KEY" in events[-1]["message"]


@pytest.mark.parametrize("status,phrase", [(401, "GROQ_API_KEY"), (429, "rate limit"), (413, "rate limit"), (500, "Groq")])
def test_groq_failures_become_readable_errors(client, paper_id, groq, status, phrase):
    groq.script("Tutor", status)
    events = ask(client, paper_id)
    assert events[-1]["type"] == "error"
    assert phrase in events[-1]["message"]


def test_invalid_intent_is_rejected(client, paper_id):
    res = client.post(f"/api/papers/{paper_id}/ask", json={"selection": "x", "page": 1, "intent": "hack"})
    assert res.status_code == 422


def test_empty_selection_is_rejected(client, paper_id):
    res = client.post(f"/api/papers/{paper_id}/ask", json={"selection": "  ", "page": 1, "intent": "explain"})
    assert res.status_code == 422


def test_requests_leave_room_under_an_8k_tokens_per_minute_limit(client, paper_id, groq):
    ask(client, paper_id)
    assert all(0 < r["max_tokens"] <= 4000 for r in groq.requests)
