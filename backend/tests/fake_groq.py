"""A stand-in for Groq and Ollama, so tests exercise the real client libraries over HTTP.

Each agent's system prompt starts with "You are the <Agent>", which is how a
request finds its scripted reply. Run directly for browser testing:
    uv run python tests/fake_groq.py 8901
"""
import json
import re
import sys
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

DEFAULT_REPLIES = {
    "Coordinator": json.dumps(
        {"kind": "concept", "terms": ["attention", "query"], "visual_form": "diagram", "brief": "Explain the idea."}
    ),
    "Tutor": "Attention lets each word **look at** the others, weighted by $q \\cdot k$ [p.1].\n\nThink of a lookup that blends results.",
    "Illustrator": 'How a query blends values.\n\n```mermaid\nflowchart LR\n  Q[Query] --> S[Scores]\n  K[Keys] --> S\n  S --> O[Weighted values]\n```',
    "Reviewer": json.dumps({"approved": True, "issues": ""}),
}


class FakeGroq:
    def __init__(self):
        self.app = FastAPI()
        self.requests: list[dict] = []
        self.loads: list[dict] = []
        self.queues: dict[str, list] = {}
        self.installed = ["gemma4:e4b"]
        self.app.post("/openai/v1/chat/completions")(self._completions)
        self.app.post("/api/chat")(self._ollama_chat)
        self.app.get("/api/tags")(self._ollama_tags)
        self.app.post("/api/generate")(self._ollama_load)
        self.app.post("/_script")(self._script_endpoint)
        self.app.post("/_reset")(self.reset)
        self.app.get("/_requests")(lambda: [{"agent": r["agent"], "api": r["api"]} for r in self.requests])

    def script(self, agent: str, *replies):
        """Queue replies for an agent. An int reply becomes that HTTP error status."""
        self.queues.setdefault(agent, []).extend(replies)

    def reset(self):
        self.requests.clear()
        self.loads.clear()
        self.queues.clear()
        self.installed = ["gemma4:e4b"]

    def calls(self, agent: str) -> list[dict]:
        return [r for r in self.requests if r["agent"] == agent]

    async def _script_endpoint(self, request: Request):
        """Lets a browser test queue replies when the fake runs as its own process."""
        body = await request.json()
        self.script(body["agent"], *body["replies"])
        return {"ok": True}

    async def _completions(self, request: Request):
        body = await request.json()
        system = body["messages"][0]["content"]
        agent = re.match(r"You are the (\w+)", system).group(1)
        self.requests.append(
            {"agent": agent, "model": body["model"], "messages": body["messages"],
             "response_format": body.get("response_format"),
             "max_tokens": body.get("max_completion_tokens") or body.get("max_tokens"),
             "api": "groq"}
        )
        queue = self.queues.get(agent)
        reply = queue.pop(0) if queue else DEFAULT_REPLIES[agent]
        if isinstance(reply, int):
            return JSONResponse({"error": {"message": "scripted failure", "type": "scripted"}}, status_code=reply)
        if body.get("stream"):
            return StreamingResponse(self._sse(body["model"], reply), media_type="text/event-stream")
        return {
            "id": "fake", "object": "chat.completion", "created": int(time.time()), "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": reply}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    async def _ollama_load(self, request: Request):
        self.loads.append(await request.json())
        return {"done": True}

    async def _ollama_tags(self):
        return {"models": [{"name": name, "model": name} for name in self.installed]}

    async def _ollama_chat(self, request: Request):
        body = await request.json()
        system = body["messages"][0]["content"]
        agent = re.match(r"You are the (\w+)", system).group(1)
        self.requests.append(
            {"agent": agent, "model": body["model"], "messages": body["messages"], "format": body.get("format"),
             "options": body.get("options") or {}, "keep_alive": body.get("keep_alive"), "think": body.get("think"),
             "api": "ollama"}
        )
        if body["model"] not in self.installed:
            return JSONResponse({"error": f"model '{body['model']}' not found"}, status_code=404)
        queue = self.queues.get(agent)
        reply = queue.pop(0) if queue else DEFAULT_REPLIES[agent]
        if isinstance(reply, int):
            return JSONResponse({"error": "scripted failure"}, status_code=reply)

        async def lines():
            for piece in re.findall(r"\S+\s*", reply):
                yield json.dumps({"model": body["model"], "created_at": "2026-11-04T00:00:00Z",
                                  "message": {"role": "assistant", "content": piece}, "done": False}) + "\n"
            yield json.dumps({"model": body["model"], "created_at": "2026-11-04T00:00:00Z",
                              "message": {"role": "assistant", "content": ""}, "done": True,
                              "done_reason": "stop"}) + "\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    async def _sse(self, model: str, reply: str):
        def frame(delta, finish=None):
            return "data: " + json.dumps({
                "id": "fake", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }) + "\n\n"
        yield frame({"role": "assistant", "content": ""})
        for piece in re.findall(r"\S+\s*", reply):
            yield frame({"content": piece})
        yield frame({}, "stop")
        yield "data: [DONE]\n\n"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    uvicorn.run(FakeGroq().app, host="127.0.0.1", port=port, log_level="warning")
