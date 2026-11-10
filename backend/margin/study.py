"""Whole-paper study aids that are one model call each: the guide and citation lookup."""
import logging
import time

from langchain_core.messages import HumanMessage, SystemMessage

from . import prompts
from .graph import model_name, parse_json
from .papers import Paper, page_number

log = logging.getLogger(__name__)

GUIDE_ATTEMPTS = 2
MAX_TERMS = 25
MAX_SECTIONS = 6


async def _call(llm, system: str, user: str) -> tuple[str, dict]:
    """Calls the model and returns its reply with a full record of the exchange, for the reader to inspect."""
    started = time.monotonic()
    output, reasoning, reply = "", "", None
    async for chunk in llm.astream([SystemMessage(system), HumanMessage(user)]):
        reply = chunk if reply is None else reply + chunk
        reasoning += chunk.additional_kwargs.get("reasoning_content") or ""
        output += chunk.text
    record = {
        "model": model_name(llm), "prompt": {"system": system, "user": user}, "output": output, "reasoning": reasoning,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    if reply is not None and reply.usage_metadata:
        record["usage"] = {"input": reply.usage_metadata["input_tokens"], "output": reply.usage_metadata["output_tokens"]}
    return output, record


def _sections(items, pages: int) -> list[dict]:
    sections = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        page, title = page_number(item.get("page"), pages), str(item.get("title") or "").strip()
        if page and title:
            sections.append({"page": page, "title": title, "why": str(item.get("why") or "").strip()})
    return sections[:MAX_SECTIONS]


def read_guide(data: dict, paper: Paper) -> dict:
    """Keeps only what can be checked against the paper. First appearances come from the text, not the model."""
    claim = str(data.get("claim") or "").strip()
    if not claim:
        raise ValueError("The guide had no main claim.")
    terms, seen = [], set()
    for item in data.get("terms") if isinstance(data.get("terms"), list) else []:
        if not isinstance(item, dict):
            continue
        term, definition = str(item.get("term") or "").strip(), str(item.get("definition") or "").strip()
        first = paper.first_page(term) if term and definition else None
        if first and term.lower() not in seen:
            seen.add(term.lower())
            terms.append({"term": term, "definition": definition, "first_page": first})
    return {
        "claim": claim,
        "read_first": _sections(data.get("read_first"), len(paper.pages)),
        "skim": _sections(data.get("skim"), len(paper.pages)),
        "terms": sorted(terms[:MAX_TERMS], key=lambda t: t["term"].lower()),
    }


async def build_guide(llm, paper: Paper) -> dict:
    abbreviations = "\n".join(f"- {name}: \"{context}\"" for name, context in paper.abbreviations())
    user = f"<paper>\n{paper.digest()}\n</paper>"
    if abbreviations:
        user += f"\n\n<paper>\nAbbreviations in the paper, each with its first use:\n{abbreviations}\n</paper>"
    failure: Exception = ValueError("The guide couldn't be written. Try again.")
    for _ in range(GUIDE_ATTEMPTS):
        text, record = await _call(llm, prompts.GUIDE, user)
        try:
            return {**read_guide(parse_json(text), paper), "record": record}
        except (ValueError, TypeError) as error:
            log.warning("Unusable guide reply: %s", error)
            failure = ValueError("The guide couldn't be written. Try again.")
    raise failure


async def explain_citation(llm, paper: Paper, numbers: list[int], page: int, marker: str, line: str) -> dict:
    """The entries come straight from the paper's reference list. Only the explanation comes from the model."""
    references = [{"number": n, "text": paper.references[n]} for n in numbers if n in paper.references]
    result = {
        "references": references, "missing": [n for n in numbers if n not in paper.references],
        "what": "", "why": "", "why_error": "", "record": None,
    }
    if not references or llm is None:
        return result
    context = paper.citing_context(page, marker, line)
    listed = "\n".join(f"<reference number=\"{r['number']}\">{r['text']}</reference>" for r in references)
    user = f"{listed}\n\n<paper page=\"{page}\">\n{context or 'The citing sentence could not be found in the extracted text.'}\n</paper>"
    try:
        text, record = await _call(llm, prompts.ARCHIVIST, user)
        data = parse_json(text)
        result.update(what=str(data.get("what") or "").strip(), why=str(data.get("why") or "").strip(), record=record)
    except Exception as error:
        # The reference itself is still worth showing when the model can't add to it.
        log.warning("Citation explanation failed: %s", error)
        result["why_error"] = "The reason for this citation couldn't be worked out. The reference above comes from the paper."
    return result
