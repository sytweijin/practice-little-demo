"""FastAPI backend - serves API and static frontend."""

import os
import json
import time
import ipaddress
from pathlib import Path
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles

from fastapi.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware

class NoCacheStatic(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/static") or request.url.path == "/":
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        return resp

class ProfileMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        profile = request.headers.get("X-Presence-Profile", "").strip()
        if not profile:
            profile = request.cookies.get("presence_profile", "").strip()
        if profile:
            memory.set_profile(profile)
        try:
            resp = await call_next(request)
        finally:
            memory.set_profile("default")
        return resp


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


STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)
(STATIC_DIR / "uploads").mkdir(exist_ok=True)
(STATIC_DIR / "assets").mkdir(exist_ok=True)

CERT_DIR = Path(__file__).parent / "cert"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_instance):
    memory.init_db()
    seed_if_empty()
    yield

app = FastAPI(title="Memory Cards API", lifespan=lifespan)
app.add_middleware(NoCacheStatic)
app.add_middleware(ProfileMiddleware)

@app.get("/api/batches")
def api_batches():
    batches = memory.list_batches()
    return {"batches": batches}


# ---- Profiles & Graph ----
@app.get("/api/profiles")
def api_profiles():
    return {"profiles": memory.list_profiles()}


class ProfileInput(BaseModel):
    name: str = "default"


@app.post("/api/profile")
def api_set_profile(data: ProfileInput):
    name = (data.name or "").strip() or "default"
    memory.set_profile(name)
    memory.init_db()
    seed_if_empty()
    return {"profile": name, "profiles": memory.list_profiles()}


@app.get("/api/graph")
def api_graph(limit: int = 200):
    return memory.graph_data(limit)


@app.get("/api/folders")
def api_folders(include_unfiled: bool = True):
    """List folders; include_unfiled adds a virtual unfiled group."""
    return {"folders": memory.list_folders(include_unfiled=include_unfiled)}



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
    batch_id: str = ""


@app.post("/api/cards")
def api_create_card(card: CardInput):
    return memory.create_card(card.dict())


@app.get("/api/cards/search")
def api_search_cards(q: str = "", scene_type: str = None):
    if not q.strip():
        return {"cards": []}
    return {"cards": memory.search_cards(q.strip(), scene_type)}


# ---- 数据导出 / 导入 ----

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
    quick_mode: bool = Form(False),
    files: list[UploadFile] = File(default=[]),
    video_frames: list[UploadFile] = File(default=[]),
):
    materials = []
    for f in files:
        content = await f.read()
        url = llm.save_upload(f.filename, content)
        ext = Path(f.filename).suffix.lower()
        ctype = (f.content_type or "").lower()
        # Classify by MIME content-type first (handles audio/webm vs video/webm),
        # then fall back to file extension.
        if ctype.startswith("video/") or ext in (".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".3gp"):
            if not (ctype.startswith("audio/")):
                materials.append({"kind": "video", "url": url, "name": f.filename, "ref": ""})
                continue
        if ctype.startswith("audio/") or ext in (".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac"):
            materials.append({"kind": "audio", "url": url, "name": f.filename, "ref": ""})
        elif ctype.startswith("image/") or ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
            materials.append({"kind": "image", "url": url, "name": f.filename, "ref": ""})
        else:
            materials.append({"kind": "text", "url": url, "name": f.filename, "ref": content.decode("utf-8", errors="ignore")[:500]})

    # Video frames extracted by the browser for AI visual analysis.
    # These are internal: they feed the vision API but never become standalone cards.
    for f in video_frames:
        content = await f.read()
        url = llm.save_upload(f.filename, content)
        materials.append({"kind": "frame", "url": url, "name": f.filename, "ref": ""})

    if notes.strip():
        materials.append({"kind": "text", "url": "", "name": "notes", "ref": notes.strip()})

    if not materials:
        raise HTTPException(400, "No materials provided")

    t0 = time.monotonic()
    cards_data, ai_used = llm.analyze_materials(materials, scene_type, personalization)
    ai_seconds = max(0.0, time.monotonic() - t0)
    scenario = get_scenario(scene_type)

    # Save as draft cards
    batch_id = str(int(datetime.now().timestamp()))
    saved = []
    for cd in cards_data:
        cd["scene_type"] = scene_type
        cd["status"] = "draft"
        cd["recall_enabled"] = scenario["recall_enabled"]
        cd["source_date"] = datetime.now().strftime("%Y-%m-%d")
        cd["batch_id"] = batch_id
        saved.append(memory.create_card(cd))

    # Record ledger (frames are internal, not counted as user materials)
    real_count = len([m for m in materials if m["kind"] != "frame"])
    minutes = real_count * scenario["minutes_per_material"]
    memory.record_ledger(scene_type, real_count, minutes, len(saved), ai_seconds=ai_seconds, quick_mode=quick_mode)

    return {"cards": saved, "materials_count": real_count, "minutes_saved": minutes, "ai_seconds": round(ai_seconds, 1), "ai_used": ai_used, "quick_mode": quick_mode}


class ConfirmInput(BaseModel):
    title: str = None
    summary: str = None
    personal: str = None
    tags: list = None


@app.post("/api/cards/{card_id}/confirm")
def api_confirm_card(card_id: int, data: dict = None):
    updates = {"status": "confirmed"}
    if data:
        for k in ("title", "summary", "personal", "tags", "recall_enabled"):
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
    seconds = data.get("seconds", 0)
    card = memory.record_recall(card_id, difficulty, seconds=seconds)
    if not card:
        raise HTTPException(404, "Card not found")
    return card


# ---- Folders ----

@app.put("/api/folders/{folder_id}")
def api_rename_folder(folder_id: str, data: dict):
    name = (data or {}).get("name", "").strip()
    if not name:
        raise HTTPException(400, "Folder name cannot be empty")
    folder = memory.rename_folder(folder_id, name)
    if not folder:
        raise HTTPException(404, "Folder not found")
    return folder


@app.delete("/api/folders/{folder_id}")
def api_delete_folder(folder_id: str, delete_cards: bool = False):
    memory.delete_folder(folder_id, delete_cards=delete_cards)
    return {"ok": True}


@app.post("/api/folders/merge")
def api_merge_folders(data: dict):
    source_id = (data or {}).get("source_id")
    target_id = (data or {}).get("target_id")
    if not source_id or not target_id:
        raise HTTPException(400, "source_id and target_id required")
    if source_id == target_id:
        raise HTTPException(400, "Cannot merge a folder into itself")
    memory.merge_folders(source_id, target_id)
    return {"ok": True}


@app.post("/api/cards/{card_id}/move")
def api_move_card(card_id: int, data: dict):
    folder_id = (data or {}).get("folder_id", "")
    card = memory.move_card(card_id, folder_id)
    if not card:
        raise HTTPException(404, "Card not found")
    return card


@app.post("/api/batch/move")
def api_batch_move(data: dict):
    card_ids = (data or {}).get("card_ids", []) or []
    folder_id = (data or {}).get("folder_id", "")
    if not card_ids:
        raise HTTPException(400, "card_ids required")
    memory.batch_move_cards([int(i) for i in card_ids], folder_id)
    return {"ok": True, "moved": len(card_ids)}


@app.post("/api/batch/delete")
def api_batch_delete(data: dict):
    card_ids = (data or {}).get("card_ids", []) or []
    if not card_ids:
        raise HTTPException(400, "card_ids required")
    memory.batch_delete_cards([int(i) for i in card_ids])
    return {"ok": True, "deleted": len(card_ids)}


# ---- Static files ----



# ---- 记忆联结 ----

@app.get("/api/cards/{card_id}/connections")
def api_card_connections(card_id: int):
    return {"connections": memory.card_connections(card_id)}
# ---- 全文搜索 ----

@app.get("/api/export")
def api_export(format: str = "json", full: bool = False):
    if full:
        snapshot = memory.export_full_snapshot()
        return JSONResponse(content=snapshot,
                           headers={"Content-Disposition": "attachment; filename=presence_snapshot.json"})
    cards = memory.export_cards_data()
    if format == "json":
        return JSONResponse(content={"cards": cards, "exported_at": datetime.now().isoformat()},
                           headers={"Content-Disposition": "attachment; filename=presence_backup.json"})


class ImportInput(BaseModel):
    cards: list
    merge: bool = False


@app.post("/api/import")
def api_import(data: ImportInput):
    imported, skipped = memory.import_cards(data.cards, merge=data.merge)
    return {"imported": imported, "skipped": skipped}


@app.post("/api/sync/import")
def api_smart_import(data: dict):
    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid snapshot format")
    imported, updated, skipped = memory.smart_import(data)
    return {"imported": imported, "updated": updated, "skipped": skipped}


# ---- 标签管理 ----

@app.get("/api/tags")
def api_list_tags():
    return {"tags": memory.list_all_tags()}


class TagRenameInput(BaseModel):
    old: str
    new: str = ""


@app.put("/api/tags/rename")
def api_rename_tag(data: TagRenameInput):
    if not data.old.strip():
        raise HTTPException(400, "old tag name is required")
    updated = memory.rename_tag(data.old.strip(), data.new.strip())
    return {"updated": updated}


# ---- Semantic Connections ----

@app.post("/api/connections/discover")
def api_discover_connections():
    cards = memory.list_cards()
    if len(cards) < 2:
        raise HTTPException(400, "Need at least 2 cards to discover connections")
    pairs, ai_used = llm.discover_connections(cards)
    added = memory.save_ai_connections(pairs)
    return {"discovered": added, "total": len(pairs), "ai_used": ai_used}


@app.get("/api/connections")
def api_connections():
    return {"connections": memory.all_ai_connections(), "exists": memory.has_ai_connections()}


@app.delete("/api/connections")
def api_clear_connections():
    memory.clear_ai_connections()
    return {"cleared": True}


@app.put("/api/connections/lock")
def api_toggle_lock(data: dict):
    card_a = int((data or {}).get("card_a", 0))
    card_b = int((data or {}).get("card_b", 0))
    if not card_a or not card_b:
        raise HTTPException(400, "card_a and card_b required")
    locked = memory.toggle_connection_lock(card_a, card_b)
    return {"locked": locked}


# ---- Narratives ----

@app.get("/api/narratives")
def api_narratives():
    return {"narratives": memory.list_narratives()}


@app.post("/api/narrative/generate")
def api_generate_narrative(data: dict):
    date_start = (data or {}).get("date_start", "")
    date_end = (data or {}).get("date_end", "")
    all_cards = memory.list_cards()
    if date_start:
        all_cards = [c for c in all_cards if c.get("source_date") and c["source_date"] >= date_start]
    if date_end:
        all_cards = [c for c in all_cards if c.get("source_date") and c["source_date"] <= date_end]
    if not all_cards:
        # Auto-fallback: find the most recent month that actually has cards
        recent = memory.list_cards()
        if recent:
            best_month = max(
                (c.get("source_date") or "")[:7] for c in recent if c.get("source_date")
            )
            if best_month:
                all_cards = [c for c in recent if (c.get("source_date") or "")[:7] == best_month]
                date_start = best_month + "-01"
                import calendar as _cal
                _y, _m = int(best_month[:4]), int(best_month[5:7])
                date_end = best_month + "-" + str(_cal.monthrange(_y, _m)[1])
                date_label = best_month
        if not all_cards:
            raise HTTPException(400, "No cards found in the selected range")
    date_label = date_start or "all"
    if date_start and date_end and date_start != date_end:
        date_label = date_start + " ~ " + date_end
    t0 = time.monotonic()
    result, ai_used = llm.generate_narrative(all_cards, date_label)
    ai_seconds = max(0.0, time.monotonic() - t0)
    if not result:
        # Fallback: a simple themed summary even without AI
        titles = [c["title"] for c in all_cards[:5]]
        result = {
            "title": date_label + " \u8bb0\u5fc6\u56de\u987e",
            "body": "\u8fd9\u6bb5\u65f6\u95f4\u4f60\u6536\u96c6\u4e86 " + str(len(all_cards)) + " \u5f20\u8bb0\u5fc6\u5361\u7247\u3002"
            + "\u672a\u63a5\u5165 AI\uff0c\u4ee5\u4e0b\u4e3a\u5360\u4f4d\u608d\u8ff0\uff1a\n\n"
            + "\n".join("- " + t for t in titles),
        }
    nid = memory.save_narrative(result["title"], result["body"], date_start, date_end, ai_used=ai_used)
    return {"id": nid, "title": result["title"], "body": result["body"], "ai_used": ai_used, "ai_seconds": round(ai_seconds, 1)}


@app.delete("/api/narratives/{nid}")
def api_delete_narrative(nid: int):
    memory.delete_narrative(nid)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _lan_ip():
    """Best-effort detection of the machine's LAN IP for phone access."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def _ensure_cert(ip=None):
    """Create or renew the local self-signed certificate for HTTPS."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return None

    CERT_DIR.mkdir(exist_ok=True)
    if CERT_FILE.exists() and KEY_FILE.exists():
        try:
            cert = x509.load_pem_x509_certificate(CERT_FILE.read_bytes())
            sans = cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName
            ).value
            ips = [str(san.value) for san in sans.get_values_for_type(x509.IPAddress)]
            if ip is None or ip in ips:
                return str(CERT_FILE), str(KEY_FILE)
        except Exception:
            pass

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "presence-memory.local")])
    alt_ips = [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    alt_names = [x509.DNSName("localhost")]
    if ip:
        try:
            alt_ips.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            alt_names.append(x509.DNSName(ip))

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(alt_ips + alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return str(CERT_FILE), str(KEY_FILE)


if __name__ == "__main__":
    import uvicorn
    ip = _lan_ip()
    cert = _ensure_cert(ip)
    print("\n========================================")
    print("  电脑访问:  https://127.0.0.1:8001")
    if ip:
        print("  手机访问:  https://" + ip + ":8001  (需和电脑连同一 WiFi；首次打开请点“高级→继续访问”)")
    print("========================================\n")
    if cert:
        uvicorn.run(
            "main:app",
            host="0.0.0.0",
            port=8001,
            ssl_certfile=cert[0],
            ssl_keyfile=cert[1],
            reload=True,
            reload_dirs=["."],
        )
    else:
        print("[提示] 未检测到 cryptography，手机端暂时只能上传录音文件；安装后重启即可浏览器内录音。")
        uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True, reload_dirs=["."])
