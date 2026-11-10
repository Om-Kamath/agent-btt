# Margin

A calm PDF reader for research papers. Highlight a passage you don't understand, then get an explanation or a picture beside the page, and keep asking until it makes sense.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Node 22.13 or newer.

1. Put your [Groq API key](https://console.groq.com/keys) in `.env` as `GROQ_API_KEY=...` (copy `.env.example`).
2. Run `./run.sh`.
3. Open http://127.0.0.1:8000.

Keep your key in `.env`, which git ignores, and leave `.env.example` blank.

Your highlights, your questions, and text from your paper are sent to Groq. Opening a new paper sends the start of every page straight away, to write its guide.

## Study tools

- **Guide:** when you first open a paper, a side panel says what it claims, what to read first, and what's safe to skim. It's written once per paper from the start of each page, then saved.
- **Terms:** hover over a term or abbreviation in the paper to see what it means there and where it first appears. The Terms tab lists them all, which also works on touch screens. Terms the paper never uses are dropped.
- **Citations:** click a numbered citation like `[12]` to see its entry from the reference list and why it's cited there. Author-year citations like (Smith, 2020) aren't supported yet.
- **Test me:** after an explanation, answer a question in your own words and get it graded against the paper. Quotes offered as evidence are only shown if they're really on that page. Grading can be lenient, so treat a vague answer marked correct with suspicion.
- **What to know first:** an ordered list of the ideas a passage depends on. Each links to its page, or says it isn't covered in this paper.
- **Highlights:** list them in reading order, hide them on the page, or remove them.
- **Export:** save your notes as Markdown, or as a PDF through the browser's print dialog.

## How it works

```
highlight -> coordinator -> librarian -> tutor or illustrator -> reviewer -> answer
                                               ^--- one rewrite ---|
```

| Agent | Job | Model |
|---|---|---|
| Coordinator | Works out what the passage is and what to search for | `openai/gpt-oss-20b` |
| Librarian | Finds related passages with BM25 (no LLM) | none |
| Tutor | Writes the explanation and streams it | `openai/gpt-oss-120b` |
| Illustrator | Draws a Mermaid diagram or an interactive HTML visual | `openai/gpt-oss-120b` |
| Reviewer | Checks the work against the paper and redoes calculations | `openai/gpt-oss-20b` |
| Pathfinder | Orders what to know before a passage | `openai/gpt-oss-120b` |
| Examiner | Writes a question to test understanding | `openai/gpt-oss-120b` |
| Grader | Grades the student's answer against the paper | `openai/gpt-oss-120b` |

The agents run on Groq. Change them with `GROQ_SMART_MODEL` and `GROQ_FAST_MODEL`. The graph is in `backend/margin/graph.py` and the prompts are in `backend/margin/prompts.py`.

Every answer shows how it was made. Each step reports what the agent decided, how long it took, its tokens, its exact prompt and reply, and the model's reasoning when the model returns any.

## Good to know

- The reviewer can miss mistakes, so treat answers as help and the paper as the source.
- Equations often garble when selected from a PDF, so the tutor reconstructs them from context. Figures can't be highlighted.
- Scanned PDFs without selectable text can't be opened.
- Interactive visuals are generated code, so they run in a sandboxed frame with no network access or access to the app.
- Papers are stored in `data/papers`. Highlights and answers are saved in your browser.

## Tests

```
cd backend && uv run pytest
cd frontend && npm test
```

Tests use a local stand-in for Groq (`backend/tests/fake_groq.py`), so they don't need a key.
