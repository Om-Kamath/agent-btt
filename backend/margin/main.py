"""Entry point: uvicorn margin.main:app"""
from dotenv import load_dotenv

from .api import ROOT, create_app

load_dotenv(ROOT / ".env")
app = create_app(static_dir=ROOT / "frontend" / "dist")
