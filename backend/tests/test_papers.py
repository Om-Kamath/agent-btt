import pytest

from conftest import make_pdf
from margin.papers import InvalidPaper, PaperStore


def test_add_extracts_text_per_page(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "attention.pdf")
    assert paper.name == "attention.pdf"
    assert len(paper.pages) == 4
    assert "Scaled dot-product" in paper.pages[1]


def test_same_file_gets_same_id_and_survives_a_new_store(tmp_path, paper_bytes):
    first = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    assert PaperStore(tmp_path).add(paper_bytes, "a.pdf").id == first.id
    assert PaperStore(tmp_path).get(first.id).pages == first.pages


def test_rejects_a_file_that_is_not_a_pdf(tmp_path):
    with pytest.raises(InvalidPaper, match="isn't a PDF"):
        PaperStore(tmp_path).add(b"hello there", "notes.pdf")


def test_rejects_a_pdf_with_no_selectable_text(tmp_path):
    with pytest.raises(InvalidPaper, match="no selectable text"):
        PaperStore(tmp_path).add(make_pdf([" "]), "scan.pdf")


@pytest.mark.parametrize("bad_id", ["../../etc/passwd", "..", "abc/def", ""])
def test_get_never_resolves_paths_outside_the_store(tmp_path, bad_id):
    assert PaperStore(tmp_path).get(bad_id) is None
    assert PaperStore(tmp_path).pdf_path(bad_id) is None


def test_search_finds_the_relevant_page(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    assert paper.search("adam optimizer warmup", k=1)[0].page == 3


def test_search_ignores_the_reference_list(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    assert all(p.page != 4 for p in paper.search("attention", k=10))


def test_around_returns_text_surrounding_a_selection_broken_across_lines(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    around = paper.around(2, "divides by   the\nsquare root", radius=40)
    assert "key dimension" in around
    assert "Training" not in around


def test_around_falls_back_to_the_page_when_selection_is_not_found(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    assert "Adam" in paper.around(3, "garbled ∑ glyphs", radius=40)


def test_around_tolerates_a_page_out_of_range(tmp_path, paper_bytes):
    paper = PaperStore(tmp_path).add(paper_bytes, "a.pdf")
    assert paper.around(99, "anything", radius=40) == ""
