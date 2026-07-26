"""SQLite 数据层 —— 卡片 CRUD、回忆调度、认知账单统计。"""

import sqlite3
import json
from datetime import datetime, timedelta
from pathlib import Path

DB_DIR = Path(__file__).parent / "data"
DB_DIR.mkdir(exist_ok=True)
DB_PATH = DB_DIR / "memory.db"


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    # Add batch_id column for existing databases
    try:
        conn.execute("ALTER TABLE cards ADD COLUMN batch_id TEXT DEFAULT ''")
    except:
        pass  # Column already exists
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_type TEXT NOT NULL DEFAULT 'custom',
        title TEXT NOT NULL,
        summary TEXT DEFAULT '',
        personal TEXT DEFAULT '',
        source_kind TEXT DEFAULT 'text',
        source_ref TEXT DEFAULT '',
        image_url TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        source_date TEXT,
        status TEXT DEFAULT 'confirmed',
        recall_enabled INTEGER DEFAULT 0,
        last_recalled TEXT,
        recall_count INTEGER DEFAULT 0,
        next_recall TEXT,
        recall_interval INTEGER DEFAULT 1,
        difficulty INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        scene_type TEXT,
        materials_count INTEGER DEFAULT 0,
        minutes_saved INTEGER DEFAULT 0,
        cards_generated INTEGER DEFAULT 0,
        focus_pct INTEGER DEFAULT 94
    );
    """)
    conn.commit()
    conn.close()


def _row_to_card(row):
    return {
        "id": row["id"],
        "scene_type": row["scene_type"],
        "title": row["title"],
        "summary": row["summary"] or "",
        "personal": row["personal"] or "",
        "source_kind": row["source_kind"],
        "source_ref": row["source_ref"] or "",
        "image_url": row["image_url"] or "",
        "tags": json.loads(row["tags"] or "[]"),
        "source_date": row["source_date"],
        "status": row["status"],
        "recall_enabled": bool(row["recall_enabled"]),
        "last_recalled": row["last_recalled"],
        "recall_count": row["recall_count"],
        "next_recall": row["next_recall"],
        "recall_interval": row["recall_interval"],
        "difficulty": row["difficulty"],
        "created_at": row["created_at"],
    }


# ---------- 卡片 CRUD ----------

def list_cards(scene_type=None, date=None):
    conn = get_db()
    q = "SELECT * FROM cards WHERE status != 'deleted'"
    params = []
    if scene_type:
        q += " AND scene_type = ?"
        params.append(scene_type)
    if date:
        q += " AND source_date = ?"
        params.append(date)
    q += " ORDER BY created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [_row_to_card(r) for r in rows]


def get_card(card_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    conn.close()
    return _row_to_card(row) if row else None


def create_card(data):
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cards
           (scene_type, title, summary, personal, source_kind, source_ref,
            image_url, tags, source_date, status, recall_enabled, batch_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            data.get("scene_type", "custom"),
            data["title"],
            data.get("summary", ""),
            data.get("personal", ""),
            data.get("source_kind", "text"),
            data.get("source_ref", ""),
            data.get("image_url", ""),
            json.dumps(data.get("tags", []), ensure_ascii=False),
            data.get("source_date", datetime.now().strftime("%Y-%m-%d")),
            data.get("status", "confirmed"),
            int(data.get("recall_enabled", False)),
            data.get("batch_id", ""),
        ),
    )
    conn.commit()
    card_id = cur.lastrowid
    conn.close()
    return get_card(card_id)


def update_card(card_id, data):
    conn = get_db()
    fields = []
    params = []
    for k in ("title", "summary", "personal", "tags", "image_url", "status", "scene_type", "recall_enabled"):
        if k in data:
            fields.append(f"{k} = ?")
            val = data[k]
            if k == "tags":
                val = json.dumps(val, ensure_ascii=False)
            if k == "recall_enabled":
                val = int(val)
            params.append(val)
    if not fields:
        return get_card(card_id)
    params.append(card_id)
    conn.execute(f"UPDATE cards SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
    conn.close()
    return get_card(card_id)


def delete_card(card_id):
    conn = get_db()
    conn.execute("UPDATE cards SET status = 'deleted' WHERE id = ?", (card_id,))
    conn.commit()
    conn.close()


# ---------- 回忆调度 ----------

RECALL_INTERVALS = {0: 1, 1: 3, 2: 7, 3: 14, 4: 30}


def _next_recall_date(interval_idx):
    days = RECALL_INTERVALS.get(min(interval_idx, len(RECALL_INTERVALS) - 1), 1)
    return (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d")


def recall_due(scene_type=None):
    """返回今天需要回忆的卡片。"""
    conn = get_db()
    today = datetime.now().strftime("%Y-%m-%d")
    q = """SELECT * FROM cards
           WHERE recall_enabled = 1 AND status = 'confirmed'
             AND (next_recall IS NULL OR next_recall <= ?)"""
    params = [today]
    if scene_type:
        q += " AND scene_type = ?"
        params.append(scene_type)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [_row_to_card(r) for r in rows]


def record_recall(card_id, difficulty):
    """difficulty: 0=简单 1=中等 2=困难，影响下次间隔。"""
    card = get_card(card_id)
    if not card:
        return None
    interval = card["recall_interval"]
    if difficulty == 0:
        interval = min(interval + 2, len(RECALL_INTERVALS) - 1)
    elif difficulty == 1:
        interval = min(interval + 1, len(RECALL_INTERVALS) - 1)
    else:
        interval = max(interval - 1, 0)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    conn = get_db()
    conn.execute(
        """UPDATE cards SET last_recalled = ?, recall_count = ?,
           next_recall = ?, recall_interval = ?, difficulty = ?
           WHERE id = ?""",
        (now, card["recall_count"] + 1, _next_recall_date(interval), interval, difficulty, card_id),
    )
    conn.commit()
    conn.close()
    return get_card(card_id)


# ---------- 批次/文件夹 ----------

def list_batches():
    conn = get_db()
    rows = conn.execute(
        """SELECT batch_id, scene_type, source_date,
                  COUNT(*) as card_count,
                  MIN(created_at) as created_at
           FROM cards
           WHERE batch_id != '' AND status != 'deleted'
           GROUP BY batch_id
           ORDER BY created_at DESC"""
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        conn2 = get_db()
        first = conn2.execute(
            "SELECT title FROM cards WHERE batch_id = ? AND status != 'deleted' ORDER BY id ASC LIMIT 1",
            (r["batch_id"],)
        ).fetchone()
        conn2.close()
        result.append({
            "batch_id": r["batch_id"],
            "scene_type": r["scene_type"],
            "source_date": r["source_date"],
            "card_count": r["card_count"],
            "title": first["title"] if first else "未命名",
            "created_at": r["created_at"],
        })
    return result


# ---------- 认知账单 ----------

def ledger_stats():
    conn = get_db()
    total_cards = conn.execute("SELECT COUNT(*) FROM cards WHERE status != 'deleted'").fetchone()[0]
    by_scene = conn.execute(
        "SELECT scene_type, COUNT(*) as c FROM cards WHERE status != 'deleted' GROUP BY scene_type"
    ).fetchall()
    total_minutes = conn.execute("SELECT COALESCE(SUM(minutes_saved),0) FROM ledger").fetchone()[0]
    total_materials = conn.execute("SELECT COALESCE(SUM(materials_count),0) FROM ledger").fetchone()[0]
    recall_total = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled = 1 AND status != 'deleted'"
    ).fetchone()[0]
    recall_done = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled = 1 AND recall_count > 0"
    ).fetchone()[0]
    today = datetime.now().strftime("%Y-%m-%d")
    due = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled=1 AND status='confirmed' AND (next_recall IS NULL OR next_recall <= ?)",
        (today,),
    ).fetchone()[0]
    conn.close()
    return {
        "total_cards": total_cards,
        "by_scene": {r["scene_type"]: r["c"] for r in by_scene},
        "total_minutes_saved": total_minutes,
        "total_materials": total_materials,
        "recall_total": recall_total,
        "recall_done": recall_done,
        "recall_due": due,
    }


def record_ledger(scene_type, materials_count, minutes_saved, cards_generated):
    conn = get_db()
    conn.execute(
        """INSERT INTO ledger (date, scene_type, materials_count, minutes_saved, cards_generated)
           VALUES (?,?,?,?,?)""",
        (datetime.now().strftime("%Y-%m-%d"), scene_type, materials_count, minutes_saved, cards_generated),
    )
    conn.commit()
    conn.close()
