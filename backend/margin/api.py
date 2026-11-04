"""HTTP API: upload a paper, fetch it, and ask the agents about a highlight over server-sent events."""
import json
import asyncio
import logging
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .graph import build_graph, initial_state
from .llm import build_providers
from .papers import InvalidPaper, PaperStore

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
MAX_SELECTION_CHARS = 6000
MAX_HISTORY_CHARS = 2000
HISTORY_TURNS = 6


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class Repair(BaseModel):
    form: Literal["mermaid", "html"]
    code: str = Field(max_length=40000)
    error: str = Field(max_length=2000)


class Ask(BaseModel):
    selection: str
    page: int
    intent: Literal["explain", "simplify", "deepen", "example", "question", "visualize", "repair"]
    question: str = Field(default="", max_length=2000)
    history: list[Turn] = []
    repair: Repair | None = None
    provider: Literal["groq", "ollama"] | None = None

    @field_validator("selection")
    @classmethod
    def selection_has_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("selection is empty")
        return value[:MAX_SELECTION_CHARS]


def _describe(paper) -> dict:
    return {"id": paper.id, "name": paper.name, "pages": len(paper.pages)}


def create_app(data_dir=None, api_key=None, base_url=None, max_upload_bytes=50 * 1024 * 1024, max_retries=2,
               static_dir=None, provider=None, ollama_url=None, ollama_model=None, allow_cloud=None) -> FastAPI:
    app = FastAPI(title="Margin")
    store = PaperStore(data_dir or ROOT / "data" / "papers")
    default, providers = build_providers(provider, api_key, base_url, max_retries, ollama_url, ollama_model, allow_cloud)
    graphs = {name: build_graph(store, p.models) if p.models else None for name, p in providers.items()}

    def readable(llm, error: Exception) -> str:
        known = llm.readable_error(error)
        if known:
            return known
        if isinstance(error, ValueError):
            return str(error)
        return "Something went wrong while answering. Try again."

    @app.get("/api/health")
    async def health(active: str | None = None):
        chosen = active or default

        async def describe(name, llm):
            message = await llm.status(preload=name == chosen)
            return {"ready": not message, "local": llm.local, "message": message, "model": llm.model}

        details = await asyncio.gather(*(describe(name, llm) for name, llm in providers.items()))
        return {"default": default, "providers": dict(zip(providers, details))}

    @app.post("/api/papers")
    async def upload(file: UploadFile):
        data = await file.read(max_upload_bytes + 1)
        if len(data) > max_upload_bytes:
            raise HTTPException(413, f"This PDF is over the {max_upload_bytes // (1024 * 1024)} MB limit.")
        try:
            paper = await run_in_threadpool(store.add, data, file.filename or "paper.pdf")
        except InvalidPaper as error:
            raise HTTPException(400, str(error)) from error
        return _describe(paper)

    def require(paper_id: str):
        paper = store.get(paper_id)
        if not paper:
            raise HTTPException(404, "This paper is no longer available. Open it again.")
        return paper

    @app.get("/api/papers/{paper_id}")
    def metadata(paper_id: str):
        return _describe(require(paper_id))

    @app.get("/api/papers/{paper_id}/file")
    def pdf(paper_id: str):
        require(paper_id)
        return FileResponse(store.pdf_path(paper_id), media_type="application/pdf")

    @app.post("/api/papers/{paper_id}/ask")
    async def ask(paper_id: str, body: Ask):
        require(paper_id)
        name = body.provider or default
        if name not in providers:
            raise HTTPException(403, "Groq is turned off for this app. Ask again using this computer.")
        llm, graph = providers[name], graphs[name]
        history = [{"role": t.role, "content": t.content[:MAX_HISTORY_CHARS]} for t in body.history[-HISTORY_TURNS:]]
        state = initial_state(
            paper_id=paper_id, selection=body.selection, page=body.page, intent=body.intent,
            question=body.question, history=history, repair=body.repair.model_dump() if body.repair else None,
        )

        def frame(event: dict) -> str:
            return f"data: {json.dumps(event)}\n\n"

        async def events():
            if graph is None:
                yield frame({"type": "error", "message": llm.setup_message})
                return
            final = state
            try:
                async for mode, chunk in graph.astream(state, stream_mode=["custom", "values"]):
                    if mode == "custom":
                        yield frame(chunk)
                    else:
                        final = chunk
            except Exception as error:
                log.exception("Agents failed")
                yield frame({"type": "error", "message": readable(llm, error)})
                return
            yield frame({
                "type": "result",
                "markdown": final["draft"],
                "visual": final["visual"],
                "via": {"provider": llm.name, "model": llm.model, "local": llm.local},
                "check": final["check"],
                "caveat": final["caveat"],
                "sources": [{"page": p["page"], "text": p["text"][:240]} for p in final["passages"]],
            })

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if static_dir and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="app")
    return app
