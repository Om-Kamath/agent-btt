"""HTTP API: upload a paper, fetch it, and ask the agents about a highlight over server-sent events."""
import asyncio
import json
import logging
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from .graph import build_graph, initial_state
from .llm import build_llm, readable_error
from .papers import InvalidPaper, PaperStore
from .study import build_guide, explain_citation

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
    intent: Literal["explain", "simplify", "deepen", "example", "question", "visualize", "repair", "prerequisites", "quiz", "grade"]
    question: str = Field(default="", max_length=2000)
    answer: str = Field(default="", max_length=4000)
    history: list[Turn] = []
    repair: Repair | None = None

    @field_validator("selection")
    @classmethod
    def selection_has_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("selection is empty")
        return value[:MAX_SELECTION_CHARS]

    @model_validator(mode="after")
    def grading_has_something_to_grade(self):
        if self.intent == "grade" and not (self.question.strip() and self.answer.strip()):
            raise ValueError("a grade needs a question and an answer")
        return self


class CitationAsk(BaseModel):
    numbers: list[int] = Field(min_length=1, max_length=8)
    page: int
    marker: str = Field(default="", max_length=200)
    line: str = Field(default="", max_length=1000)


def _describe(paper) -> dict:
    return {"id": paper.id, "name": paper.name, "pages": len(paper.pages), "references": sorted(paper.references)}


def create_app(data_dir=None, api_key=None, base_url=None, max_upload_bytes=50 * 1024 * 1024, max_retries=2,
               static_dir=None) -> FastAPI:
    app = FastAPI(title="Margin")
    store = PaperStore(data_dir or ROOT / "data" / "papers")
    llm = build_llm(api_key, base_url, max_retries)
    graph = build_graph(store, llm.models) if llm.models else None

    guide_locks: dict[str, asyncio.Lock] = {}

    def readable(error: Exception) -> str:
        known = readable_error(error)
        if known:
            return known
        if isinstance(error, ValueError):
            return str(error)
        return "Something went wrong while answering. Try again."

    @app.get("/api/health")
    async def health():
        return {"ready": not llm.setup_message, "message": llm.setup_message, "model": llm.model}

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

    @app.post("/api/papers/{paper_id}/guide")
    async def guide(paper_id: str):
        paper = require(paper_id)
        if not llm.models:
            raise HTTPException(503, llm.setup_message)
        # The page can ask twice while the first is still writing, and each one costs tokens.
        async with guide_locks.setdefault(paper_id, asyncio.Lock()):
            saved = store.read_guide(paper_id)
            if saved:
                return saved
            try:
                made = await build_guide(llm.models.careful, paper)
            except Exception as error:
                log.exception("Guide failed")
                raise HTTPException(502, readable(error)) from error
            store.write_guide(paper_id, made)
            return made

    @app.post("/api/papers/{paper_id}/citation")
    async def citation(paper_id: str, body: CitationAsk):
        paper = require(paper_id)
        careful = llm.models.careful if llm.models else None
        return await explain_citation(careful, paper, body.numbers, body.page, body.marker, body.line)

    @app.post("/api/papers/{paper_id}/ask")
    async def ask(paper_id: str, body: Ask):
        require(paper_id)
        history = [{"role": t.role, "content": t.content[:MAX_HISTORY_CHARS]} for t in body.history[-HISTORY_TURNS:]]
        state = initial_state(
            paper_id=paper_id, selection=body.selection, page=body.page, intent=body.intent,
            question=body.question, answer=body.answer, history=history, repair=body.repair.model_dump() if body.repair else None,
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
                yield frame({"type": "error", "message": readable(error)})
                return
            yield frame({
                "type": "result",
                "markdown": final["draft"],
                "visual": final["visual"],
                "via": {"provider": "groq", "model": llm.model},
                "check": final["check"],
                "caveat": final["caveat"],
                "study": final.get("study"),
                "sources": [{"page": p["page"], "text": p["text"][:240]} for p in final["passages"]],
            })

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if static_dir and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="app")
    return app
