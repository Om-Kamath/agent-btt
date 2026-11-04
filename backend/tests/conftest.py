import socket
import threading
import time

import pytest
import uvicorn
from fpdf import FPDF

from fake_groq import FakeGroq


@pytest.fixture(scope="session")
def _groq_server():
    fake = FakeGroq()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(fake.app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    yield fake, f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join()


@pytest.fixture
def groq(_groq_server):
    fake, _ = _groq_server
    fake.reset()
    return fake


@pytest.fixture
def groq_url(_groq_server):
    return _groq_server[1]


def make_pdf(pages: list[str]) -> bytes:
    pdf = FPDF()
    pdf.set_font("Helvetica", size=11)
    for text in pages:
        pdf.add_page()
        pdf.multi_cell(0, 6, text)
    return bytes(pdf.output())


PAGES = [
    "Attention Is All You Need. Abstract. We propose the Transformer, based solely on attention mechanisms.",
    "Scaled dot-product attention computes the dot products of the query with all keys and divides by the "
    "square root of the key dimension. A softmax then gives weights on the values.",
    "Training used the Adam optimizer with warmup steps. Label smoothing improved accuracy on translation.",
    "References\n[1] Bahdanau et al. Neural machine translation by jointly learning to align. attention attention",
]


@pytest.fixture
def paper_bytes():
    return make_pdf(PAGES)
