# Margin

A calm PDF reader for research papers. Highlight a passage you don't understand, then get an explanation or a picture beside the page, and keep asking until it makes sense.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Node 22.13 or newer.

1. Put your [Groq API key](https://console.groq.com/keys) in `.env` as `GROQ_API_KEY=...` (copy `.env.example`).
2. Run `./run.sh`.
3. Open http://127.0.0.1:8000.

Keep your key in `.env`, which git ignores, and leave `.env.example` blank.

## Run it privately with Ollama

Keep your papers on this computer, with no internet needed once it's set up:

1. Install [Ollama](https://ollama.com) and run `ollama pull gemma4:e4b` (a 9.5 GB download).
2. Set `LLM_PROVIDER=ollama` in `.env`.
3. Run `./run.sh`. The toolbar shows "This computer" as selected.

In this mode:

- Nothing goes to Groq unless you switch to it, and a mistyped provider stops the app instead of falling back to the cloud.
- Ollama `-cloud` models are refused, because they would send your papers off this computer.
- LangSmith tracing is turned off.

To use another model, set `OLLAMA_MODEL`. Answers are slower and usually weaker than Groq's, especially interactive visuals.

## Switch between them

Use the toolbar to switch between "This computer" and "Groq". Each answer says which model wrote it.

- Switching to Groq asks you to confirm first, because passages from your paper will be sent to Groq.
- Each time the app opens, it returns to `LLM_PROVIDER` from `.env`.
- If Ollama fails, the app shows the error and doesn't try Groq.
- Set `ALLOW_CLOUD=false` in `.env` to remove Groq from the app completely.

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

The table shows the Groq models. With Ollama, every agent uses one local model, so a low-memory computer doesn't have to swap between models. Change Groq's with `GROQ_SMART_MODEL` and `GROQ_FAST_MODEL`. The graph is in `backend/margin/graph.py` and the prompts are in `backend/margin/prompts.py`.

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

Tests use a local stand-in for Groq and Ollama (`backend/tests/fake_groq.py`), so they don't need a key.
