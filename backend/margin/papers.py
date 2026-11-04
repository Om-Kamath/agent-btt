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


@dataclass
class Paper:
    id: str
    name: str
    pages: list[str]

    @cached_property
    def _passages(self) -> list[Passage]:
        """Overlapping chunks of body text, with the reference list left out."""
        pages = list(self.pages)
        for i in range(len(pages) - 1, len(pages) // 2 - 1, -1):
            matches = list(_REFERENCES.finditer(pages[i]))
            if matches:
                pages[i] = pages[i][: matches[-1].start()]
                pages[i + 1 :] = [""] * (len(pages) - i - 1)
                break
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
        """Rank body passages against the query with BM25."""
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
        return [self._passages[i] for i in ranked[:k] if scores[i] > 0]

    def around(self, page: int, selection: str, radius: int = 800) -> str:
        """Text around the selection, or the start of the page if the selection can't be located."""
        if not 1 <= page <= len(self.pages):
            return ""
        text = _collapse(self.pages[page - 1])
        at = text.lower().find(_collapse(selection).lower())
        if at < 0:
            return text[: radius * 2]
        return text[max(0, at - radius) : at + len(_collapse(selection)) + radius]


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

    def ids(self) -> list[str]:
        return [p.name for p in self.root.iterdir() if p.is_dir() and _ID.fullmatch(p.name)]
