"""FastAPI backend - serves API and static frontend."""

import os
import json
from pathlib import Path
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import memory
import llm
from scenarios import SCENARIO_LIST, get_scenario
from seed import seed_if_empty

app = FastAPI(title="Memory Cards API")

STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)
(STATIC_DIR / "uploads").mkdir(exist_ok=True)
(STATIC_DIR / "assets").mkdir(exist_ok=True)


@app.on_event("startup")
def startup():
    memory.init_db()
    seed_if_empty()


# ---- Scenarios ----
@app.get("/api/scenarios")
def api_scenarios():
    return {"scenarios": SCENARIO_LIST}


# ---- Cards ----
@app.get("/api/cards")
def api_list_cards(scene_type: str = None, date: str = None):
    return {"cards": memory.list_cards(scene_type, date)}


class CardInput(BaseModel):
    scene_type: str = "custom"
    title: str
    summary: str = ""
    personal: str = ""
    source_kind: str = "text"
    source_ref: str = ""
    image_url: str = ""
    tags: list = []
    source_date: str = None
    status: str = "confirmed"
    recall_enabled: bool = False


@app.post("/api/cards")
def api_create_card(card: CardInput):
    return memory.create_card(card.dict())


@app.put("/api/cards/{card_id}")
def api_update_card(card_id: int, data: dict):
    card = memory.update_card(card_id, data)
    if not card:
        raise HTTPException(404, "Card not found")
    return card


@app.delete("/api/cards/{card_id}")
def api_delete_card(card_id: int):
    memory.delete_card(card_id)
    return {"ok": True}


# ---- Analyze (upload + AI) ----
@app.post("/api/analyze")
async def api_analyze(
    scene_type: str = Form("custom"),
    personalization: str = Form(""),
    notes: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    materials = []
    for f in files:
        content = await f.read()
        url = llm.save_upload(f.filename, content)
        ext = Path(f.filename).suffix.lower()
        if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
            materials.append({"kind": "image", "url": url, "name": f.filename, "ref": ""})
        elif ext in (".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac"):
            materials.append({"kind": "audio", "url": url, "name": f.filename, "ref": ""})
        else:
            materials.append({"kind": "text", "url": url, "name": f.filename, "ref": content.decode("utf-8", errors="ignore")[:500]})

    if notes.strip():
        materials.append({"kind": "text", "url": "", "name": "notes", "ref": notes.strip()})

    if not materials:
        raise HTTPException(400, "No materials provided")

    cards_data = llm.analyze_materials(materials, scene_type, personalization)
    scenario = get_scenario(scene_type)

    # Save as draft cards
    saved = []
    for cd in cards_data:
        cd["scene_type"] = scene_type
        cd["status"] = "draft"
        cd["recall_enabled"] = scenario["recall_enabled"]
        cd["source_date"] = datetime.now().strftime("%Y-%m-%d")
        saved.append(memory.create_card(cd))

    # Record ledger
    minutes = len(materials) * scenario["minutes_per_material"]
    memory.record_ledger(scene_type, len(materials), minutes, len(saved))

    return {"cards": saved, "materials_count": len(materials), "minutes_saved": minutes}


class ConfirmInput(BaseModel):
    title: str = None
    summary: str = None
    personal: str = None
    tags: list = None


@app.post("/api/cards/{card_id}/confirm")
def api_confirm_card(card_id: int, data: dict = None):
    updates = {"status": "confirmed"}
    if data:
        for k in ("title", "summary", "personal", "tags"):
            if data.get(k) is not None:
                updates[k] = data[k]
    card = memory.update_card(card_id, updates)
    if not card:
        raise HTTPException(404, "Card not found")
    return card


# ---- Cognitive Ledger ----
@app.get("/api/ledger")
def api_ledger():
    return memory.ledger_stats()


# ---- Recall ----
@app.get("/api/recall/due")
def api_recall_due(scene_type: str = None):
    return {"cards": memory.recall_due(scene_type)}


@app.post("/api/recall/{card_id}/attempt")
def api_recall_attempt(card_id: int, data: dict):
    difficulty = data.get("difficulty", 1)
    card = memory.record_recall(card_id, difficulty)
    if not card:
        raise HTTPException(404, "Card not found")
    return card


# ---- Static files ----
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
