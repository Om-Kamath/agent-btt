"""Builds the agents' language models, which run on Groq."""
import os
from dataclasses import dataclass

import groq
from langchain_groq import ChatGroq

from .graph import Models

NO_KEY = "Add your Groq API key to get explanations. Put GROQ_API_KEY in the .env file, then restart the server."


@dataclass
class Llm:
    model: str
    models: Models | None
    setup_message: str = ""


def readable_error(error: Exception) -> str | None:
    if isinstance(error, groq.AuthenticationError):
        return "Groq rejected the API key. Check GROQ_API_KEY in the .env file, then restart the server."
    if isinstance(error, groq.RateLimitError) or getattr(error, "status_code", None) == 413:
        return "Groq's rate limit was reached. Wait a minute, then try again."
    if isinstance(error, groq.APIConnectionError):
        return "Groq couldn't be reached. Check your connection, then try again."
    if isinstance(error, groq.APIStatusError):
        return f"Groq returned an error ({error.status_code}). Try again."
    return None


def build_llm(api_key=None, base_url=None, max_retries=2) -> Llm:
    # LangChain sends traces to LangSmith when these are set, which would include paper text.
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"

    key = os.environ.get("GROQ_API_KEY", "") if api_key is None else api_key
    base = base_url or os.environ.get("GROQ_API_BASE") or None
    smart_model = os.environ.get("GROQ_SMART_MODEL") or "openai/gpt-oss-120b"

    def llm(model: str, max_tokens: int) -> ChatGroq:
        # Reasoning models spend completion tokens on thinking, so limits can't be tight, but a limit
        # near the plan's tokens-per-minute could get a request refused outright.
        options = {"base_url": base} if base else {}
        return ChatGroq(model=model, api_key=key, max_tokens=max_tokens, max_retries=max_retries, timeout=90, **options)

    if not key:
        return Llm(smart_model, None, NO_KEY)
    fast = llm(os.environ.get("GROQ_FAST_MODEL") or "openai/gpt-oss-20b", 2000)
    return Llm(smart_model, Models(fast=fast, smart=llm(smart_model, 4000)))
