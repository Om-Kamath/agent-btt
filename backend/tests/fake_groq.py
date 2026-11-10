"""A stand-in for Groq, so tests exercise the real client libraries over HTTP.

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
    "Pathfinder": json.dumps({"steps": [
        {"idea": "dot products", "why": "Scores come from them.", "page": 2},
        {"idea": "quantum entanglement", "why": "Outside the paper.", "page": None},
    ]}),
    "Examiner": json.dumps({"question": "Why divide by the root of the key dimension?"}),
    "Grader": json.dumps({
        "verdict": "partly", "feedback": "Right idea, but say why.", "correct_idea": "It keeps the scores in a useful range.",
        "evidence": [{"page": 2, "quote": "divides by the square root"}, {"page": 2, "quote": "words the paper never says"}],
    }),
    "Guide": json.dumps({
        "claim": "The Transformer replaces recurrence with attention.",
        "read_first": [{"page": 2, "title": "Scaled dot-product attention", "why": "The core idea"}, {"page": 99, "title": "Made up", "why": "x"}],
        "skim": [{"page": 3, "title": "Training", "why": "Details"}],
        "terms": [{"term": "Transformer", "definition": "The paper's model."}, {"term": "softmax", "definition": "Turns scores into weights."},
                  {"term": "Flux capacitor", "definition": "Not in the paper."}],
    }),
    "Archivist": json.dumps({"what": "A paper on translation.", "why": "It introduced attention, which this paper builds on."}),
}


def _split(reply) -> tuple[str, str]:
    return (reply["content"], reply.get("reasoning", "")) if isinstance(reply, dict) else (reply, "")


class FakeGroq:
    def __init__(self):
        self.app = FastAPI()
        self.requests: list[dict] = []
        self.queues: dict[str, list] = {}
        self.app.post("/openai/v1/chat/completions")(self._completions)
        self.app.post("/_script")(self._script_endpoint)
        self.app.post("/_reset")(self.reset)
        self.app.get("/_requests")(lambda: [{"agent": r["agent"], "api": r["api"]} for r in self.requests])

    def script(self, agent: str, *replies):
        """Queue replies for an agent. An int reply becomes that HTTP error status. A dict sets content and reasoning."""
        self.queues.setdefault(agent, []).extend(replies)

    def reset(self):
        self.requests.clear()
        self.queues.clear()

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
        reply, reasoning = _split(reply)
        if body.get("stream"):
            return StreamingResponse(self._sse(body["model"], reply, reasoning), media_type="text/event-stream")
        return {
            "id": "fake", "object": "chat.completion", "created": int(time.time()), "model": body["model"],
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": reply}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    async def _sse(self, model: str, reply: str, reasoning: str = ""):
        def frame(delta, finish=None, **extra):
            return "data: " + json.dumps({
                "id": "fake", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra,
            }) + "\n\n"
        yield frame({"role": "assistant", "content": ""})
        for piece in re.findall(r"\S+\s*", reasoning):
            yield frame({"reasoning": piece})
        for piece in re.findall(r"\S+\s*", reply):
            yield frame({"content": piece})
        usage = {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
        yield frame({}, "stop", x_groq={"usage": usage})
        yield "data: [DONE]\n\n"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    uvicorn.run(FakeGroq().app, host="127.0.0.1", port=port, log_level="warning")
