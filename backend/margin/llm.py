"""Chooses where the agents' language model runs: Groq's cloud or Ollama on this machine."""
import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlparse

import groq
import httpx
import ollama
from langchain_groq import ChatGroq
from langchain_ollama import ChatOllama

from .graph import Models

log = logging.getLogger(__name__)

NO_KEY = "Add your Groq API key to get explanations. Put GROQ_API_KEY in the .env file, then restart the server."
DEFAULT_OLLAMA_MODEL = "gemma4:e4b"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
# Ollama's default context is small and it drops the overflow without saying so, which would
# quietly lose the paper's passages. This holds the prompt plus the longest allowed reply.
OLLAMA_CONTEXT_TOKENS = 8192
OLLAMA_WRITER_TOKENS = 4000
OLLAMA_JSON_TOKENS = 2000
OLLAMA_TIMEOUT_SECONDS = 300
OLLAMA_KEEP_ALIVE = "30m"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


@dataclass
class Provider:
    name: str
    model: str
    local: bool
    models: Models | None
    readable_error: Callable[[Exception], str | None]
    url: str = ""
    setup_message: str = ""
    _load_task: asyncio.Task | None = field(default=None, repr=False)

    async def status(self, preload: bool = False) -> str:
        """What the reader must do before asking anything, or an empty string if nothing."""
        if self.name == "groq":
            return self.setup_message
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                response = await client.get(f"{self.url}/api/tags")
                response.raise_for_status()
        except httpx.HTTPError:
            return _ollama_off()
        installed = {m.get("name") for m in response.json().get("models", [])}
        if self.model in installed or f"{self.model}:latest" in installed:
            if preload:
                self._start_loading()
            return ""
        return _ollama_missing(self.model)

    def _start_loading(self):
        """Loads the model when the page opens, so the first question doesn't wait for it."""
        if not self._load_task:
            self._load_task = asyncio.create_task(self._load())

    async def _load(self):
        body = {"model": self.model, "keep_alive": OLLAMA_KEEP_ALIVE, "options": {"num_ctx": OLLAMA_CONTEXT_TOKENS}}
        try:
            async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT_SECONDS) as client:
                (await client.post(f"{self.url}/api/generate", json=body)).raise_for_status()
        except httpx.HTTPError as error:
            # Not worth reporting: the first question will load it, or explain the problem.
            log.warning("Couldn't load %s ahead of time: %s", self.model, error)


def _ollama_off() -> str:
    return "Ollama isn't running. Open Ollama, then try again."


def _ollama_missing(model: str) -> str:
    return f"The model {model} isn't installed. Run: ollama pull {model}"


def _groq_error(error: Exception) -> str | None:
    if isinstance(error, groq.AuthenticationError):
        return "Groq rejected the API key. Check GROQ_API_KEY in the .env file, then restart the server."
    if isinstance(error, groq.RateLimitError) or getattr(error, "status_code", None) == 413:
        return "Groq's rate limit was reached. Wait a minute, then try again."
    if isinstance(error, groq.APIConnectionError):
        return "Groq couldn't be reached. Check your connection, then try again."
    if isinstance(error, groq.APIStatusError):
        return f"Groq returned an error ({error.status_code}). Try again."
    return None


def _ollama_error(model: str) -> Callable[[Exception], str | None]:
    def describe(error: Exception) -> str | None:
        if isinstance(error, (ConnectionError, httpx.ConnectError)):
            return _ollama_off()
        if isinstance(error, httpx.TimeoutException):
            return "The local model took too long to answer. Try again, or use a smaller model."
        if isinstance(error, ollama.ResponseError):
            if error.status_code == 404:
                return _ollama_missing(model)
            return f"Ollama reported a problem: {error.error}"
        return None

    return describe


def _build_groq(api_key, base_url, max_retries) -> Provider:
    key = os.environ.get("GROQ_API_KEY", "") if api_key is None else api_key
    base = base_url or os.environ.get("GROQ_API_BASE") or None
    smart_model = os.environ.get("GROQ_SMART_MODEL") or "openai/gpt-oss-120b"

    def llm(model: str, max_tokens: int) -> ChatGroq:
        # Reasoning models spend completion tokens on thinking, so limits can't be tight, but a limit
        # near the plan's tokens-per-minute could get a request refused outright.
        options = {"base_url": base} if base else {}
        return ChatGroq(model=model, api_key=key, max_tokens=max_tokens, max_retries=max_retries, timeout=90, **options)

    models = None
    if key:
        fast = llm(os.environ.get("GROQ_FAST_MODEL") or "openai/gpt-oss-20b", 2000)
        models = Models(fast=fast, smart=llm(smart_model, 4000))
    return Provider("groq", smart_model, False, models, _groq_error, setup_message="" if key else NO_KEY)


def _build_ollama(url, model_name) -> Provider:
    model = model_name or os.environ.get("OLLAMA_MODEL") or DEFAULT_OLLAMA_MODEL
    if model.endswith("-cloud") or model.endswith(":cloud"):
        raise ValueError(
            f"{model} is an Ollama cloud model, which would send your papers off this computer. "
            "Choose a local model for OLLAMA_MODEL."
        )
    base = (url or os.environ.get("OLLAMA_BASE_URL") or DEFAULT_OLLAMA_URL).rstrip("/")

    # LangChain sends traces to LangSmith when these are set, which would include paper text, even
    # for questions answered locally. They're process-wide, so they're off for both providers.
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"

    def llm(max_tokens: int, **options) -> ChatOllama:
        return ChatOllama(
            model=model, base_url=base, num_ctx=OLLAMA_CONTEXT_TOKENS, num_predict=max_tokens, keep_alive=OLLAMA_KEEP_ALIVE,
            client_kwargs={"timeout": OLLAMA_TIMEOUT_SECONDS}, **options,
        )

    # Measured on gemma4:e4b: without thinking the coordinator took 4s instead of 24s and the tutor 23s
    # instead of 45s, with no visible loss. The reviewer can't go without it: it rejected every correct
    # answer. The illustrator keeps it too, because it writes code.
    writer = llm(OLLAMA_WRITER_TOKENS, reasoning=False)
    models = Models(
        fast=writer, smart=writer,
        structured=llm(OLLAMA_JSON_TOKENS, format="json", reasoning=False),
        reviewer=llm(OLLAMA_JSON_TOKENS, format="json"),
        illustrator=llm(OLLAMA_WRITER_TOKENS),
    )
    local = urlparse(base).hostname in LOCAL_HOSTS
    return Provider("ollama", model, local, models, _ollama_error(model), url=base)


def build_providers(default=None, api_key=None, base_url=None, max_retries=2, ollama_url=None, ollama_model=None,
                    allow_cloud=None) -> tuple[str, dict[str, Provider]]:
    """Returns the default provider's name and every provider a request may choose."""
    name = (default or os.environ.get("LLM_PROVIDER") or "groq").strip().lower()
    if name not in ("groq", "ollama"):
        # No fallback: someone who asked for local must never end up on a cloud model because of a typo.
        raise ValueError(f'LLM_PROVIDER must be "groq" or "ollama", not "{name}".')
    if allow_cloud is None:
        allow_cloud = os.environ.get("ALLOW_CLOUD", "true").strip().lower() != "false"
    if name == "groq" and not allow_cloud:
        raise ValueError('ALLOW_CLOUD=false can\'t be combined with LLM_PROVIDER=groq. Set LLM_PROVIDER=ollama.')
    providers = {"ollama": _build_ollama(ollama_url, ollama_model)}
    if allow_cloud:
        providers["groq"] = _build_groq(api_key, base_url, max_retries)
    return name, providers
