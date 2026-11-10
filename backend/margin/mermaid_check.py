"""Checks Mermaid with the parser the browser uses, so a broken diagram is redrawn before anyone reviews it."""
import asyncio
import logging
from pathlib import Path

log = logging.getLogger(__name__)

NODE = "node"
SCRIPT = str(Path(__file__).resolve().parents[2] / "frontend" / "check-mermaid.mjs")
TIMEOUT_SECONDS = 10
MAX_ERROR_CHARS = 600


async def find_syntax_error(code: str) -> str | None:
    """Why the diagram won't parse, or None if it parses or can't be checked here.

    An unavailable check isn't a failure: the browser still reports diagrams it can't draw.
    """
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            NODE, SCRIPT, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=Path(__file__).parent,
        )
        out, err = await asyncio.wait_for(process.communicate(code.encode()), TIMEOUT_SECONDS)
    except (OSError, asyncio.TimeoutError) as error:
        log.warning("Couldn't check Mermaid syntax: %s", repr(error))
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        return None
    if process.returncode == 0:
        return None
    message = out.decode(errors="replace").strip()
    if process.returncode != 1 or not message:
        # The checker itself broke, for example because the packages aren't installed.
        log.warning("Mermaid check didn't run: %s", err.decode(errors="replace")[:300])
        return None
    return message[:MAX_ERROR_CHARS]
