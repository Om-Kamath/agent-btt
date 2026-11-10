"""Stores uploaded papers on disk and finds passages in them."""
import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import cached_property
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader

_ID = re.compile(r"[0-9a-f]{32}")
_WORD = re.compile(r"[a-z0-9]+")
_REFERENCES = re.compile(r"^\s*(\d+\.?\s*)?(references|bibliography)\s*$", re.I | re.M)
CHUNK_CHARS = 700
CHUNK_OVERLAP = 100
DIGEST_CHARS = 12000
_FILLER = {"and", "the", "its", "with", "for", "from", "how", "why", "what", "that", "their", "into"}
SUGGESTED_PAGE_MATCH = 0.6
SEARCHED_PAGE_MATCH = 0.75
MAX_REFERENCE_CHARS = 700
MAX_LAST_REFERENCE_CHARS = 400  # Nothing marks where the last entry ends, and appendices often follow it.
# Reference lists number their entries in one of these ways. Entries are found in order, which rules out stray numbers.
_ENTRY_STYLES = (r"^\s*\[{n}\]\s*", r"^\s*{n}\.\s+", r"^\s*{n}\s+(?=[A-Z])")
_ENTRY_GAPS_ALLOWED = 2
_ABBREVIATION = re.compile(r"\b[A-Z][A-Za-z]*[A-Z0-9][A-Za-z0-9]*\b")


class InvalidPaper(ValueError):
    """The upload can't be used; the message is written for the reader."""


@dataclass(frozen=True)
class Passage:
    page: int
    text: str


def _collapse(text: str) -> str:
    """Undo PDF line wrapping so selections and extracted text can be compared."""
    return re.sub(r"\s+", " ", re.sub(r"-\s*\n\s*", "", text)).strip()


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def page_number(value, pages: int) -> int | None:
    """A page number from a model's reply, which may write it as text, if it's in the paper."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if 1 <= number <= pages else None


@dataclass
class Paper:
    id: str
    name: str
    pages: list[str]

    @cached_property
    def _split(self) -> tuple[list[str], str]:
        """The pages with the reference list cut out, and the reference list by itself."""
        pages = list(self.pages)
        for i in range(len(pages) - 1, len(pages) // 2 - 1, -1):
            matches = list(_REFERENCES.finditer(pages[i]))
            if matches:
                at = matches[-1]
                references = "\n".join([pages[i][at.end() :], *pages[i + 1 :]])
                pages[i] = pages[i][: at.start()]
                pages[i + 1 :] = [""] * (len(pages) - i - 1)
                return pages, references
        return pages, ""

    @cached_property
    def references(self) -> dict[int, str]:
        """The numbered entries of the reference list, or nothing if the paper doesn't number them."""
        text = self._split[1]
        best: list[tuple[int, int, int]] = []
        for style in _ENTRY_STYLES:
            found, position, number, misses = [], 0, 1, 0
            while misses <= _ENTRY_GAPS_ALLOWED:
                match = re.compile(style.format(n=number), re.M).search(text, position)
                if match:
                    found.append((number, match.start(), match.end()))
                    position, misses = match.end(), 0
                else:
                    misses += 1
                number += 1
            if len(found) > len(best):
                best = found
        if len(best) < 2:
            return {}
        ends = [start for _, start, _ in best[1:]] + [len(text)]
        entries = {number: _collapse(text[body:end])[:MAX_REFERENCE_CHARS] for (number, _, body), end in zip(best, ends)}
        entries[best[-1][0]] = entries[best[-1][0]][:MAX_LAST_REFERENCE_CHARS]
        return entries

    @cached_property
    def _body(self) -> list[str]:
        return [_collapse(page) for page in self._split[0]]

    @cached_property
    def _passages(self) -> list[Passage]:
        """Overlapping chunks of body text, with the reference list left out."""
        pages = self._split[0]
        chunks = []
        for number, text in enumerate(pages, start=1):
            text = _collapse(text)
            for start in range(0, len(text), CHUNK_CHARS - CHUNK_OVERLAP):
                piece = text[start : start + CHUNK_CHARS]
                if piece.strip():
                    chunks.append(Passage(number, piece))
                if start + CHUNK_CHARS >= len(text):
                    break
        return chunks

    def search(self, query: str, k: int = 4) -> list[Passage]:
        return [passage for passage, _ in self.ranked(query, k)]

    def ranked(self, query: str, k: int = 4) -> list[tuple[Passage, float]]:
        """Rank body passages against the query with BM25, keeping their scores."""
        k1, b = 1.5, 0.75
        docs = [Counter(_tokens(p.text)) for p in self._passages]
        if not docs:
            return []
        lengths = [sum(d.values()) for d in docs]
        average = sum(lengths) / len(docs)
        scores = [0.0] * len(docs)
        for term in set(_tokens(query)):
            containing = sum(1 for d in docs if term in d)
            if not containing:
                continue
            idf = math.log(1 + (len(docs) - containing + 0.5) / (containing + 0.5))
            for i, doc in enumerate(docs):
                tf = doc[term]
                scores[i] += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * lengths[i] / average))
        ranked = sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)
        return [(self._passages[i], scores[i]) for i in ranked[:k] if scores[i] > 0]

    def around(self, page: int, selection: str, radius: int = 800) -> str:
        """Text around the selection, or the start of the page if the selection can't be located."""
        if not 1 <= page <= len(self.pages):
            return ""
        text = _collapse(self.pages[page - 1])
        at = text.lower().find(_collapse(selection).lower())
        if at < 0:
            return text[: radius * 2]
        return text[max(0, at - radius) : at + len(_collapse(selection)) + radius]

    def digest(self, max_chars: int = DIGEST_CHARS) -> str:
        """The start of every page, so a long paper fits in one request and no section goes unseen."""
        pages = [(number, text) for number, text in enumerate(self._body, start=1) if text]
        budget = max_chars // max(len(pages), 1)
        return "\n\n".join(f"[p.{number}]\n{text[:budget]}" for number, text in pages)

    def abbreviations(self, limit: int = 20) -> list[tuple[str, str]]:
        """The paper's most used abbreviations, each with the text around its first use."""
        text = " ".join(self._body)
        counts = Counter(_ABBREVIATION.findall(text))
        common = [name for name, count in counts.most_common(limit) if count >= 2]
        return [(name, text[max(0, at - 100) : at + 80]) for name in common for at in [text.find(name)]]

    def first_page(self, term: str) -> int | None:
        """The first page using a term, or nothing if the paper never does."""
        pattern = term_pattern(term)
        return next((number for number, text in enumerate(self._body, start=1) if pattern.search(text)), None)

    def locate(self, idea: str, preferred=None) -> int | None:
        """A page that discusses an idea: the suggested one if it really does, or else the best match, or nothing."""
        words = [word[:5] for word in _tokens(re.sub(r"\(.*?\)", " ", idea)) if len(word) > 2 and word not in _FILLER]
        if not words:
            return None

        def share(text: str) -> float:
            present = _tokens(text)
            return sum(any(token.startswith(word) for token in present) for word in words) / len(words)

        # A model's page needs less proof than a keyword match, but it can't name a page that barely mentions the idea.
        suggested = page_number(preferred, len(self._body))
        if suggested and share(self._body[suggested - 1]) >= SUGGESTED_PAGE_MATCH:
            return suggested
        return next((found.page for found, _ in self.ranked(idea, k=3) if share(found.text) >= SEARCHED_PAGE_MATCH), None)

    def has_quote(self, page: int, quote: str) -> bool:
        if not quote.strip():
            return False
        squeeze = lambda text: "".join(_tokens(text))  # Tolerates PDF ligatures, spacing, and punctuation.
        return squeeze(quote) in squeeze(self.pages[page - 1])

    def citing_context(self, page: int, marker: str, line: str, radius: int = 500) -> str:
        """Text around the citation that was clicked, or nothing if it can't be found on the page."""
        if not 1 <= page <= len(self.pages):
            return ""
        text = _collapse(self.pages[page - 1])
        for needle in (_collapse(line), _collapse(marker)):
            at = text.find(needle) if needle else -1
            if at >= 0:
                return text[max(0, at - radius) : at + len(needle) + radius]
        return ""


def term_pattern(term: str) -> re.Pattern:
    """Matches a term and its plural. Abbreviations must match exactly, because case carries their meaning."""
    flags = 0 if any(c.isupper() for c in term[1:]) else re.I
    return re.compile(rf"(?<![\w-]){re.escape(term)}s?(?![\w-])", flags)


class PaperStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, Paper] = {}

    def add(self, data: bytes, name: str) -> Paper:
        if not data.startswith(b"%PDF-"):
            raise InvalidPaper("This file isn't a PDF. Choose a .pdf file.")
        try:
            reader = PdfReader(BytesIO(data))
            if reader.is_encrypted and not reader.decrypt(""):
                raise InvalidPaper("This PDF is password protected. Remove the password, then open it again.")
            pages = [self._page_text(page) for page in reader.pages]
        except InvalidPaper:
            raise
        except Exception as error:
            raise InvalidPaper("This PDF couldn't be read. It may be damaged.") from error
        if not "".join(pages).strip():
            raise InvalidPaper("This PDF has no selectable text, so it can't be highlighted. It may be a scan.")

        paper_id = hashlib.sha256(data).hexdigest()[:32]
        folder = self.root / paper_id
        folder.mkdir(exist_ok=True)
        (folder / "paper.pdf").write_bytes(data)
        clean_name = Path(name or "paper.pdf").name[:200]
        (folder / "meta.json").write_text(json.dumps({"name": clean_name, "pages": pages}))
        self._cache.pop(paper_id, None)
        return self.get(paper_id)

    @staticmethod
    def _page_text(page) -> str:
        try:
            return page.extract_text() or ""
        except Exception:
            return ""

    def get(self, paper_id: str) -> Paper | None:
        if not _ID.fullmatch(paper_id):
            return None
        if paper_id not in self._cache:
            meta = self.root / paper_id / "meta.json"
            if not meta.exists():
                return None
            data = json.loads(meta.read_text())
            self._cache[paper_id] = Paper(paper_id, data["name"], data["pages"])
        return self._cache[paper_id]

    def pdf_path(self, paper_id: str) -> Path | None:
        return self.root / paper_id / "paper.pdf" if self.get(paper_id) else None

    def read_guide(self, paper_id: str) -> dict | None:
        path = self.root / paper_id / "guide.json"
        return json.loads(path.read_text()) if path.exists() else None

    def write_guide(self, paper_id: str, guide: dict):
        (self.root / paper_id / "guide.json").write_text(json.dumps(guide))

    def ids(self) -> list[str]:
        return [p.name for p in self.root.iterdir() if p.is_dir() and _ID.fullmatch(p.name)]
