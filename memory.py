"""SQLite 数据层 —— 卡片 CRUD、回忆调度、认知账单统计。"""

import sqlite3
import json
import re
import contextvars
import uuid
from datetime import datetime, timedelta
from pathlib import Path

DB_DIR = Path(__file__).parent / "data"
DB_DIR.mkdir(exist_ok=True)

_profile_var = contextvars.ContextVar("presence_profile", default="default")


def set_profile(name):
    name = (name or "default").strip() or "default"
    # Reject path-traversal and filesystem-unsafe characters so a profile
    # name like "../../x" can never escape the data directory.
    name = re.sub(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]", "_", name)
    _profile_var.set(name)


def current_profile():
    return _profile_var.get()


def _db_path():
    name = current_profile()
    if name == "default":
        return DB_DIR / "memory.db"
    return DB_DIR / ("memory_" + name + ".db")


def _connect():
    conn = sqlite3.connect(str(_db_path()), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def get_db():
    if not _db_path().exists():
        init_db()
    return _connect()


def init_db():
    conn = _connect()
    for migration in (
        "ALTER TABLE cards ADD COLUMN batch_id TEXT DEFAULT ''",
        "ALTER TABLE cards ADD COLUMN recall_seconds INTEGER DEFAULT 0",
        "ALTER TABLE ledger ADD COLUMN ai_seconds REAL DEFAULT 0",
        "ALTER TABLE ledger ADD COLUMN quick_mode INTEGER DEFAULT 0",
        "ALTER TABLE ledger ADD COLUMN quick_mode INTEGER DEFAULT 0",  # idempotent guard
        "ALTER TABLE ai_connections ADD COLUMN locked INTEGER DEFAULT 0",
    ):
        try:
            conn.execute(migration)
        except Exception:
            pass
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
        batch_id TEXT DEFAULT '',
        recall_seconds INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        scene_type TEXT,
        materials_count INTEGER DEFAULT 0,
        minutes_saved INTEGER DEFAULT 0,
        cards_generated INTEGER DEFAULT 0,
        focus_pct INTEGER DEFAULT 0,
        ai_seconds REAL DEFAULT 0,
        quick_mode INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ai_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_a INTEGER NOT NULL,
        card_b INTEGER NOT NULL,
        reason TEXT DEFAULT "",
        created_at TEXT DEFAULT (datetime('now','localtime')),
        locked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT DEFAULT "",
        date_start TEXT,
        date_end TEXT,
        ai_used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS folders (
        folder_id TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        scene_type TEXT DEFAULT 'custom',
        source_date TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS custom_scenes (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        accent TEXT DEFAULT '#525252',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    """)
    conn.commit()
    _migrate_folders(conn)
    conn.close()


def _migrate_folders(conn):
    """Ensure every existing batch_id has a matching folders row."""
    rows = conn.execute(
        """SELECT DISTINCT batch_id FROM cards
           WHERE batch_id != '' AND status != 'deleted'"""
    ).fetchall()
    for r in rows:
        bid = r["batch_id"]
        exists = conn.execute(
            "SELECT folder_id FROM folders WHERE folder_id = ?", (bid,)
        ).fetchone()
        if not exists:
            meta = conn.execute(
                """SELECT scene_type, source_date, MIN(created_at) AS created_at
                   FROM cards WHERE batch_id = ? AND status != 'deleted'
                   ORDER BY id ASC LIMIT 1""",
                (bid,),
            ).fetchone()
            conn.execute(
                """INSERT INTO folders (folder_id, name, scene_type, source_date, created_at)
                   VALUES (?,?,?,?,?)""",
                (bid, "", meta["scene_type"] if meta else "custom",
                 meta["source_date"] if meta else None, meta["created_at"] if meta else None),
            )
    conn.commit()


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
        "recall_seconds": row["recall_seconds"] if "recall_seconds" in row.keys() else 0,
        "batch_id": row["batch_id"] if "batch_id" in row.keys() else "",
        "created_at": row["created_at"],
    }


# ---------- 卡片 CRUD ----------

def list_cards(scene_type=None, date=None):
    conn = get_db()
    q = "SELECT * FROM cards WHERE status = 'confirmed'"
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
    bid = data.get("batch_id", "")
    if bid:
        _ensure_folder(bid, data.get("scene_type", "custom"), data.get("source_date"))
    return get_card(card_id)


def _ensure_folder(folder_id, scene_type, source_date=None):
    """Create a folders row if it does not yet exist (idempotent)."""
    conn = get_db()
    exists = conn.execute(
        "SELECT folder_id FROM folders WHERE folder_id = ?", (folder_id,)
    ).fetchone()
    if not exists:
        conn.execute(
            """INSERT INTO folders (folder_id, name, scene_type, source_date, created_at)
               VALUES (?,?,?,?,?)""",
            (folder_id, "", scene_type or "custom",
             source_date or datetime.now().strftime("%Y-%m-%d"),
             datetime.now().strftime("%Y-%m-%d %H:%M")),
        )
        conn.commit()
    conn.close()


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
        conn.close()
        return get_card(card_id)
    # First-time recall enable: seed schedule at level 0 (+1 day) so the card
    # is not instantly due. Without this next_recall stays NULL and
    # recall_due() matches it on the very next poll.
    if data.get("recall_enabled"):
        row = conn.execute(
            "SELECT recall_count, next_recall FROM cards WHERE id = ?", (card_id,)
        ).fetchone()
        if row and row["recall_count"] == 0 and not row["next_recall"]:
            fields.append("recall_interval = ?")
            fields.append("next_recall = ?")
            params.append(0)
            params.append(_next_recall_date(0))
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


def _keyword_overlap(user_text, card):
    """Compute the fraction of card keywords the user recalled.
    Splits Chinese text into 2-char grams + Latin words, then measures
    how many of the card key terms appear in the user attempt."""
    if not user_text or not user_text.strip():
        return None
    reference = (card.get("title", "") + card.get("summary", "") +
                 "".join(card.get("tags") or []))
    if not reference.strip():
        return None
    def extract_keys(text):
        keys = set()
        # Chinese 2-char grams
        cjk = re.findall(r"[一-鿿]+", text)
        for seg in cjk:
            for i in range(len(seg) - 1):
                keys.add(seg[i:i+2])
            if len(seg) == 1:
                keys.add(seg)
        # Latin words (len >= 3)
        for w in re.findall(r"[a-zA-Z]{3,}", text):
            keys.add(w.lower())
        return keys
    ref_keys = extract_keys(reference)
    user_keys = extract_keys(user_text)
    if not ref_keys:
        return None
    matched = ref_keys & user_keys
    return round(len(matched) / len(ref_keys), 2)


def record_recall(card_id, difficulty, seconds=0, user_text=""):
    """difficulty: 0=简单 1=中等 2=困难，影响下次间隔；seconds 记录本次回忆投入秒数。
    user_text: the user free-recall attempt, used to compute keyword overlap."""
    card = get_card(card_id)
    if not card:
        return None
    match_rate = _keyword_overlap(user_text, card)
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
           next_recall = ?, recall_interval = ?, difficulty = ?,
           recall_seconds = recall_seconds + ?
           WHERE id = ?""",
        (now, card["recall_count"] + 1, _next_recall_date(interval), interval, difficulty,
         max(0, int(seconds or 0)), card_id),
    )
    conn.commit()
    conn.close()
    result = get_card(card_id)
    if result is not None:
        result["recall_match_rate"] = match_rate
    return result


# ---------- 批次/文件夹 ----------

# ---------- Folders ----------

def list_folders(include_unfiled=False):
    """List all folders with card counts; title falls back to first card."""
    conn = get_db()
    rows = conn.execute(
        """SELECT f.folder_id, f.name, f.scene_type, f.source_date, f.created_at,
                  (SELECT COUNT(*) FROM cards c
                   WHERE c.batch_id = f.folder_id AND c.status = 'confirmed') AS card_count
           FROM folders f
           ORDER BY f.created_at DESC"""
    ).fetchall()
    result = []
    for r in rows:
        first = conn.execute(
            "SELECT title FROM cards WHERE batch_id = ? AND status = 'confirmed' ORDER BY id ASC LIMIT 1",
            (r["folder_id"],)
        ).fetchone()
        result.append({
            "folder_id": r["folder_id"],
            "batch_id": r["folder_id"],
            "name": r["name"] or "",
            "scene_type": r["scene_type"],
            "source_date": r["source_date"],
            "card_count": r["card_count"],
            "title": r["name"] or (first["title"] if first else ""),
            "created_at": r["created_at"],
        })
    result = [f for f in result if f["card_count"] > 0]
    if include_unfiled:
        unfiled = conn.execute(
            """SELECT COUNT(*) AS c FROM cards
               WHERE (batch_id IS NULL OR batch_id = '') AND status = 'confirmed'"""
        ).fetchone()["c"]
        result.append({
            "folder_id": "", "batch_id": "", "name": "", "scene_type": "custom",
            "source_date": None, "card_count": unfiled, "title": "",
            "created_at": None, "is_unfiled": True,
        })
    conn.close()
    return result


def get_folder(folder_id):
    conn = get_db()
    r = conn.execute("SELECT * FROM folders WHERE folder_id = ?", (folder_id,)).fetchone()
    conn.close()
    if not r:
        return None
    return {"folder_id": r["folder_id"], "name": r["name"] or "",
            "scene_type": r["scene_type"], "source_date": r["source_date"],
            "created_at": r["created_at"]}


def rename_folder(folder_id, name):
    conn = get_db()
    conn.execute("UPDATE folders SET name = ? WHERE folder_id = ?", (name, folder_id))
    conn.commit()
    conn.close()
    return get_folder(folder_id)


def delete_folder(folder_id, delete_cards=False):
    conn = get_db()
    if delete_cards:
        conn.execute("UPDATE cards SET status = 'deleted' WHERE batch_id = ?", (folder_id,))
    else:
        conn.execute("UPDATE cards SET batch_id = '' WHERE batch_id = ?", (folder_id,))
    conn.execute("DELETE FROM folders WHERE folder_id = ?", (folder_id,))
    conn.commit()
    conn.close()


def merge_folders(source_id, target_id):
    conn = get_db()
    target = conn.execute(
        "SELECT scene_type FROM folders WHERE folder_id = ?", (target_id,)
    ).fetchone()
    target_scene = target["scene_type"] if target else "custom"
    conn.execute(
        "UPDATE cards SET batch_id = ?, scene_type = ? WHERE batch_id = ?",
        (target_id, target_scene, source_id),
    )
    conn.execute("DELETE FROM folders WHERE folder_id = ?", (source_id,))
    conn.commit()
    conn.close()


def batch_move_cards(card_ids, folder_id):
    """Move many cards into one folder (creates the folder if missing)."""
    if not card_ids:
        return
    conn = get_db()
    target_scene = "custom"
    if folder_id:
        row = conn.execute(
            "SELECT scene_type FROM folders WHERE folder_id = ?", (folder_id,)
        ).fetchone()
        if not row:
            first = conn.execute(
                "SELECT scene_type, source_date FROM cards WHERE id IN (%s) ORDER BY id ASC LIMIT 1"
                % ",".join("?" * len(card_ids)), card_ids
            ).fetchone()
            if first:
                conn.execute(
                    """INSERT INTO folders (folder_id, name, scene_type, source_date, created_at)
                       VALUES (?,?,?,?,?)""",
                    (folder_id, "", first["scene_type"], first["source_date"],
                     datetime.now().strftime("%Y-%m-%d %H:%M")),
                )
                target_scene = first["scene_type"]
        else:
            target_scene = row["scene_type"]
    placeholders = ",".join("?" * len(card_ids))
    conn.execute(
        "UPDATE cards SET batch_id = ?, scene_type = ? WHERE id IN (%s)" % placeholders,
        [folder_id, target_scene] + list(card_ids),
    )
    conn.commit()
    conn.close()


def batch_delete_cards(card_ids):
    """Soft-delete many cards."""
    if not card_ids:
        return
    conn = get_db()
    placeholders = ",".join("?" * len(card_ids))
    conn.execute(
        "UPDATE cards SET status = 'deleted' WHERE id IN (%s)" % placeholders,
        list(card_ids),
    )
    conn.commit()
    conn.close()


def move_card(card_id, folder_id):
    conn = get_db()
    target_scene = "custom"
    if folder_id:
        row = conn.execute(
            "SELECT scene_type FROM folders WHERE folder_id = ?", (folder_id,)
        ).fetchone()
        if not row:
            card = conn.execute("SELECT scene_type, source_date FROM cards WHERE id = ?", (card_id,)).fetchone()
            if card:
                conn.execute(
                    """INSERT INTO folders (folder_id, name, scene_type, source_date, created_at)
                       VALUES (?,?,?,?,?)""",
                    (folder_id, "", card["scene_type"], card["source_date"],
                     datetime.now().strftime("%Y-%m-%d %H:%M")),
                )
                target_scene = card["scene_type"]
        else:
            target_scene = row["scene_type"]
    conn.execute(
        "UPDATE cards SET batch_id = ?, scene_type = ? WHERE id = ?",
        (folder_id, target_scene, card_id),
    )
    conn.commit()
    conn.close()
    return get_card(card_id)


def list_batches():
    """Back-compat alias for older callers."""
    return list_folders()


# ---------- 自定义场景 ----------

def _custom_scene_row(r):
    return {
        "key": r["key"],
        "name": (r["name"] or "").strip() or "自定义",
        "icon": "sparkles",
        "accent": r["accent"] or "#525252",
        "recall_enabled": False,
        "focus_prompt": "用户自行判断哪些值得留存。AI 按通用标准筛选：信息密度、独特性、对用户的长远价值。",
        "card_hint": "自由格式",
        "minutes_per_material": 4,
        "is_custom": True,
    }


def list_custom_scenes():
    conn = get_db()
    rows = conn.execute(
        "SELECT key, name, accent FROM custom_scenes ORDER BY created_at ASC, key ASC"
    ).fetchall()
    conn.close()
    return [_custom_scene_row(r) for r in rows]


def get_custom_scene(key):
    conn = get_db()
    r = conn.execute(
        "SELECT key, name, accent FROM custom_scenes WHERE key = ?", (key,)
    ).fetchone()
    conn.close()
    return _custom_scene_row(r) if r else None


def create_custom_scene(name, accent=None):
    key = "custom_" + uuid.uuid4().hex[:12]
    conn = get_db()
    conn.execute(
        "INSERT INTO custom_scenes (key, name, accent) VALUES (?,?,?)",
        (key, (name or "").strip()[:40], accent or "#525252"),
    )
    conn.commit()
    conn.close()
    return get_custom_scene(key)


def update_custom_scene(key, name=None, accent=None):
    conn = get_db()
    row = conn.execute("SELECT key FROM custom_scenes WHERE key = ?", (key,)).fetchone()
    if not row:
        conn.close()
        return None
    fields = []
    params = []
    if name is not None:
        fields.append("name = ?")
        params.append((name or "").strip()[:40])
    if accent:
        fields.append("accent = ?")
        params.append(accent)
    if fields:
        params.append(key)
        conn.execute(
            "UPDATE custom_scenes SET %s WHERE key = ?" % ", ".join(fields), params
        )
    conn.commit()
    conn.close()
    return get_custom_scene(key)


def delete_custom_scene(key):
    conn = get_db()
    conn.execute("UPDATE cards SET scene_type = 'custom' WHERE scene_type = ?", (key,))
    conn.execute("UPDATE folders SET scene_type = 'custom' WHERE scene_type = ?", (key,))
    conn.execute("DELETE FROM custom_scenes WHERE key = ?", (key,))
    conn.commit()
    conn.close()

# ---------- 认知账单 ----------

def ledger_stats():
    conn = get_db()
    total_cards = conn.execute("SELECT COUNT(*) FROM cards WHERE status = 'confirmed'").fetchone()[0]
    by_scene = conn.execute(
        "SELECT scene_type, COUNT(*) as c FROM cards WHERE status = 'confirmed' GROUP BY scene_type"
    ).fetchall()
    total_minutes = conn.execute("SELECT COALESCE(SUM(minutes_saved),0) FROM ledger").fetchone()[0]
    total_materials = conn.execute("SELECT COALESCE(SUM(materials_count),0) FROM ledger").fetchone()[0]
    recall_total = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled = 1 AND status = 'confirmed'"
    ).fetchone()[0]
    recall_done = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled = 1 AND recall_count > 0 AND status = 'confirmed'"
    ).fetchone()[0]
    today = datetime.now().strftime("%Y-%m-%d")
    due = conn.execute(
        "SELECT COUNT(*) FROM cards WHERE recall_enabled=1 AND status='confirmed' AND (next_recall IS NULL OR next_recall <= ?)",
        (today,),
    ).fetchone()[0]
    total_analysis_seconds = conn.execute("SELECT COALESCE(SUM(ai_seconds),0) FROM ledger").fetchone()[0]
    quick_mode_count = conn.execute("SELECT COUNT(*) FROM ledger WHERE quick_mode = 1").fetchone()[0]
    deep_mode_count = conn.execute("SELECT COUNT(*) FROM ledger WHERE quick_mode = 0").fetchone()[0]
    total_recall_seconds = conn.execute("SELECT COALESCE(SUM(recall_seconds),0) FROM cards").fetchone()[0]
    recall_sessions = conn.execute("SELECT COUNT(*) FROM cards WHERE recall_count > 0 AND status = 'confirmed'").fetchone()[0]
    avg_difficulty = conn.execute("SELECT COALESCE(AVG(difficulty),0) FROM cards WHERE difficulty > 0 AND status = 'confirmed'").fetchone()[0]
    conn.close()
    return {
        "total_cards": total_cards,
        "by_scene": {r["scene_type"]: r["c"] for r in by_scene},
        "total_minutes_saved": total_minutes,
        "total_materials": total_materials,
        "total_analysis_seconds": total_analysis_seconds,
        "total_recall_seconds": total_recall_seconds,
        "recall_total": recall_total,
        "recall_done": recall_done,
        "recall_sessions": recall_sessions,
        "avg_difficulty": round(avg_difficulty, 2),
        "recall_due": due,
        "quick_mode_count": quick_mode_count,
        "deep_mode_count": deep_mode_count,
    }


def record_ledger(scene_type, materials_count, minutes_saved, cards_generated, ai_seconds=0, quick_mode=False):
    conn = get_db()
    conn.execute(
        """INSERT INTO ledger (date, scene_type, materials_count, minutes_saved, cards_generated, ai_seconds, quick_mode)
           VALUES (?,?,?,?,?,?,?)""",
        (datetime.now().strftime("%Y-%m-%d"), scene_type, materials_count, minutes_saved, cards_generated,
         max(0.0, float(ai_seconds or 0)), int(bool(quick_mode))),
    )
    conn.commit()
    conn.close()


# ========== 记忆联结 ==========

def card_connections(card_id, limit=6):
    """Find cards that share at least one tag with the target card.
    Returns the most related cards plus the tags they share — the thin
    threads that connect memories across scenes and time."""
    target = get_card(card_id)
    if not target:
        return []
    my_tags = set(target.get("tags") or [])
    if not my_tags:
        return []
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM cards WHERE status = 'confirmed' AND id != ? ORDER BY created_at DESC",
        (card_id,),
    ).fetchall()
    result = []
    for r in rows:
        tags = set(json.loads(r["tags"] or "[]"))
        shared = my_tags & tags
        if shared:
            card = _row_to_card(r)
            card["shared_tags"] = sorted(shared)
            result.append(card)
    conn.close()
    # rank by number of shared tags, then recency
    result.sort(key=lambda c: (len(c["shared_tags"]), c["created_at"]), reverse=True)
    # Merge AI-discovered connections
    ai_conns = get_ai_connections(card_id)
    seen = {c["id"] for c in result}
    for ac in ai_conns:
        if ac["id"] not in seen:
            ac["ai_reason"] = ac.pop("reason", "")
            result.append(ac)
    return result[:limit]


# ========== 全文搜索 ==========

def search_cards(query, scene_type=None):
    u"""Full-text search across title, summary, personal, tags, source_ref."""
    conn = get_db()
    terms = [t.strip() for t in query.split() if t.strip()]
    if not terms:
        return []
    conditions = []
    params = []
    for term in terms:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = "%" + escaped + "%"
        conditions.append("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR personal LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR source_ref LIKE ? ESCAPE '\\')")
        params.extend([like, like, like, like, like])
    sql = "SELECT * FROM cards WHERE status = 'confirmed' AND " + " AND ".join(conditions)
    if scene_type:
        sql += " AND scene_type = ?"
        params.append(scene_type)
    sql += " ORDER BY created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [_row_to_card(r) for r in rows]


# ========== 导出 / 导入 ==========

def export_cards_data(include_drafts=False):
    u"""Return cards as dicts. Confirmed only by default; full snapshots may include drafts."""
    conn = get_db()
    cond = "status != 'deleted'" if include_drafts else "status = 'confirmed'"
    rows = conn.execute("SELECT * FROM cards WHERE " + cond + " ORDER BY created_at DESC").fetchall()
    conn.close()
    return [_row_to_card(r) for r in rows]


def import_cards(cards_list, merge=False):
    u"""Import cards from a list of dicts. If merge=True, skip existing by title+source_date match."""
    imported = 0
    skipped = 0
    conn = get_db()
    for cd in cards_list:
        title = cd.get("title", "")
        source_date = cd.get("source_date", "")
        if merge:
            existing = conn.execute(
                "SELECT id FROM cards WHERE title = ? AND source_date = ? AND status != 'deleted'",
                (title, source_date),
            ).fetchone()
            if existing:
                skipped += 1
                continue
        conn.execute(
            """INSERT INTO cards
               (scene_type, title, summary, personal, source_kind, source_ref,
                image_url, tags, source_date, status, recall_enabled, batch_id, created_at,
                last_recalled, recall_count, next_recall, recall_interval, difficulty, recall_seconds)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cd.get("scene_type", "custom"),
                title,
                cd.get("summary", ""),
                cd.get("personal", ""),
                cd.get("source_kind", "text"),
                cd.get("source_ref", ""),
                cd.get("image_url", ""),
                json.dumps(cd.get("tags", []), ensure_ascii=False),
                source_date or datetime.now().strftime("%Y-%m-%d"),
                cd.get("status", "confirmed"),
                int(cd.get("recall_enabled", False)),
                cd.get("batch_id", ""),
                cd.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M"),
                cd.get("last_recalled"),
                cd.get("recall_count", 0),
                cd.get("next_recall"),
                cd.get("recall_interval", 1),
                cd.get("difficulty", 0),
                cd.get("recall_seconds", 0),
            ),
        )
        imported += 1
    conn.commit()
    conn.close()
    return imported, skipped


# ========== 多档案 / 记忆图谱 ==========

def list_profiles():
    """扫描 data 目录，返回所有可用档案（default 与 memory_*.db）。"""
    names = ["default"]
    for f in sorted(DB_DIR.glob("memory_*.db")):
        names.append(f.stem[len("memory_"):])
    result = []
    for name in names:
        token = _profile_var.set(name)
        conn = _connect()
        try:
            total = conn.execute("SELECT COUNT(*) FROM cards WHERE status = 'confirmed'").fetchone()[0]
        except Exception:
            total = 0
        conn.close()
        _profile_var.reset(token)
        result.append({"name": name, "card_count": total})
    return result


def graph_data(limit=200):
    """返回卡片-标签二部图数据，供前端绘制记忆图谱。"""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, scene_type, tags, source_date FROM cards "
        "WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    cards = []
    tag_nodes = {}
    links = []
    for r in rows:
        tags = json.loads(r["tags"] or "[]")
        cid = "card-" + str(r["id"])
        cards.append({
            "id": cid,
            "card_id": r["id"],
            "title": r["title"],
            "scene_type": r["scene_type"],
            "source_date": r["source_date"],
            "tags": tags,
        })
        for t in tags:
            tid = "tag-" + t
            if tid not in tag_nodes:
                tag_nodes[tid] = {"id": tid, "name": t, "count": 0}
            tag_nodes[tid]["count"] += 1
            links.append({"source": cid, "target": tid})
    # Add AI-discovered connections as separate links
    ai_links = []
    try:
        conn2 = get_db()
        ai_rows = conn2.execute("SELECT card_a, card_b, reason, locked FROM ai_connections").fetchall()
        for ar in ai_rows:
            ai_links.append({"source": "card-" + str(ar["card_a"]), "target": "card-" + str(ar["card_b"]), "reason": ar["reason"] or "", "ai": True, "locked": bool(ar["locked"])})
        conn2.close()
    except Exception:
        pass
    return {
        "cards": cards,
        "tags": sorted(tag_nodes.values(), key=lambda n: -n["count"]),
        "links": links,
        "ai_links": ai_links,
    }


# ========== 标签管理 ==========

def list_all_tags():
    u"""Return all unique tags with card count, sorted by count desc."""
    conn = get_db()
    rows = conn.execute(
        "SELECT tags FROM cards WHERE status = 'confirmed' AND tags != '[]'"
    ).fetchall()
    tag_counts = {}
    for r in rows:
        try:
            for t in json.loads(r["tags"] or "[]"):
                tag_counts[t] = tag_counts.get(t, 0) + 1
        except (json.JSONDecodeError, TypeError):
            pass
    conn.close()
    return sorted([{"name": k, "count": v} for k, v in tag_counts.items()], key=lambda x: -x["count"])


def rename_tag(old_tag, new_tag):
    u"""Rename a tag in all cards. new_tag='' removes the tag."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, tags FROM cards WHERE status = 'confirmed' AND tags LIKE ?",
        ("%%" + old_tag + "%%",),
    ).fetchall()
    updated = 0
    for r in rows:
        try:
            tags = json.loads(r["tags"] or "[]")
            changed = False
            new_tags = []
            for t in tags:
                if t == old_tag:
                    changed = True
                    if new_tag:
                        new_tags.append(new_tag)
                else:
                    new_tags.append(t)
            if changed:
                conn.execute(
                    "UPDATE cards SET tags = ? WHERE id = ?",
                    (json.dumps(new_tags, ensure_ascii=False), r["id"]),
                )
                updated += 1
        except (json.JSONDecodeError, TypeError):
            pass
    conn.commit()
    conn.close()
    return updated


# ========== AI Connections ==========

def save_ai_connections(pairs):
    """Incremental merge: add only NEW connection pairs, keep existing ones.

    Existing connections (especially locked ones) are never overwritten.
    Returns the count of newly added connections."""
    conn = get_db()
    existing = set()
    for r in conn.execute("SELECT card_a, card_b FROM ai_connections").fetchall():
        key = (min(r["card_a"], r["card_b"]), max(r["card_a"], r["card_b"]))
        existing.add(key)
    added = 0
    for p in pairs:
        a, b = int(p["a"]), int(p["b"])
        key = (min(a, b), max(a, b))
        if key not in existing:
            conn.execute(
                "INSERT INTO ai_connections (card_a, card_b, reason) VALUES (?,?,?)",
                (a, b, p.get("reason", "")),
            )
            existing.add(key)
            added += 1
    conn.commit()
    conn.close()
    return added


def get_ai_connections(card_id):
    """Get AI-discovered connections involving a specific card."""
    conn = get_db()
    rows = conn.execute(
        """SELECT card_a, card_b, reason, created_at FROM ai_connections
           WHERE card_a = ? OR card_b = ?""",
        (card_id, card_id),
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        other_id = r["card_b"] if r["card_a"] == card_id else r["card_a"]
        card = get_card(other_id)
        if card:
            card["reason"] = r["reason"] or ""
            card["created_at"] = r["created_at"]
            result.append(card)
    return result


def all_ai_connections():
    """Return all AI connections for graph rendering."""
    conn = get_db()
    rows = conn.execute("SELECT card_a, card_b, reason, locked FROM ai_connections").fetchall()
    conn.close()
    return [{"a": r["card_a"], "b": r["card_b"], "reason": r["reason"] or "", "locked": bool(r["locked"])} for r in rows]


def has_ai_connections():
    """Check if any AI connections exist."""
    conn = get_db()
    try:
        count = conn.execute("SELECT COUNT(*) FROM ai_connections").fetchone()[0]
    except Exception:
        count = 0
    conn.close()
    return count > 0


def clear_ai_connections():
    """Delete UNLOCKED AI connections only. Locked ones are preserved."""
    conn = get_db()
    try:
        conn.execute("DELETE FROM ai_connections WHERE locked = 0")
        conn.commit()
    except Exception:
        pass
    conn.close()


def toggle_connection_lock(card_a, card_b):
    """Toggle the locked status of a specific connection pair.
    Returns the new locked state (True/False)."""
    conn = get_db()
    lo = min(card_a, card_b)
    hi = max(card_a, card_b)
    row = conn.execute(
        "SELECT locked FROM ai_connections WHERE card_a=? AND card_b=?",
        (lo, hi),
    ).fetchone()
    if not row:
        # Try reversed order
        row = conn.execute(
            "SELECT locked FROM ai_connections WHERE card_a=? AND card_b=?",
            (hi, lo),
        ).fetchone()
    if not row:
        conn.close()
        return False
    new_state = 0 if row["locked"] else 1
    conn.execute(
        "UPDATE ai_connections SET locked=? WHERE (card_a=? AND card_b=?) OR (card_a=? AND card_b=?)",
        (new_state, lo, hi, hi, lo),
    )
    conn.commit()
    conn.close()
    return bool(new_state)


# ========== Narratives ==========

def save_narrative(title, body, date_start=None, date_end=None, ai_used=False):
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO narratives (title, body, date_start, date_end, ai_used)
           VALUES (?,?,?,?,?)""",
        (title, body, date_start, date_end, int(bool(ai_used))),
    )
    conn.commit()
    nid = cur.lastrowid
    conn.close()
    return nid


def list_narratives():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM narratives ORDER BY created_at DESC"
        ).fetchall()
    except Exception:
        conn.close()
        return []
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "title": r["title"],
            "body": r["body"] or "",
            "date_start": r["date_start"],
            "date_end": r["date_end"],
            "ai_used": bool(r["ai_used"]),
            "created_at": r["created_at"],
        })
    conn.close()
    return result


def get_narrative(nid):
    conn = get_db()
    r = conn.execute("SELECT * FROM narratives WHERE id = ?", (nid,)).fetchone()
    conn.close()
    if not r:
        return None
    return {
        "id": r["id"], "title": r["title"], "body": r["body"] or "",
        "date_start": r["date_start"], "date_end": r["date_end"],
        "ai_used": bool(r["ai_used"]), "created_at": r["created_at"],
    }


def delete_narrative(nid):
    conn = get_db()
    conn.execute("DELETE FROM narratives WHERE id = ?", (nid,))
    conn.commit()
    conn.close()


# ========== Full Snapshot Export / Smart Import ==========

def export_full_snapshot():
    """Export ALL data: cards, narratives, ai_connections.
    This is a true backup — nothing is lost on restore."""
    cards = export_cards_data(include_drafts=True)
    narratives = list_narratives()
    ai_conns = all_ai_connections()
    folders = list_folders_data()
    return {
        "version": 2,
        "exported_at": datetime.now().isoformat(),
        "cards": cards,
        "narratives": narratives,
        "ai_connections": ai_conns,
        "folders": folders,
    }


def list_folders_data():
    """Raw folder rows for export (excludes the virtual unfiled group)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT folder_id, name, scene_type, source_date, created_at "
        "FROM folders ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [{"folder_id": r["folder_id"], "name": r["name"] or "", "scene_type": r["scene_type"], "source_date": r["source_date"], "created_at": r["created_at"]} for r in rows]


def smart_import(snapshot):
    """Import a full snapshot with merge intelligence.
    - Cards matched by title+source_date: update if incoming is newer.
    - Narratives and AI connections: append (idempotent on re-import by title).
    Returns (cards_imported, cards_updated, cards_skipped)."""
    imported = 0
    updated = 0
    skipped = 0
    conn = get_db()

    cards_list = snapshot.get("cards", [])
    for cd in cards_list:
        title = cd.get("title", "")
        source_date = cd.get("source_date", "")
        existing = conn.execute(
            "SELECT id, created_at, status FROM cards WHERE title = ? AND source_date = ? AND status != 'deleted'",
            (title, source_date),
        ).fetchone()
        if existing:
            # Card exists — update only if incoming has newer or equal created_at
            # and preserve the newer recall progress
            in_created = cd.get("created_at") or ""
            in_status = cd.get("status", "confirmed")
            # A confirmed card must never be downgraded by an older draft snapshot.
            if in_status != "confirmed" and existing["status"] == "confirmed":
                in_status = "confirmed"
            if in_created and in_created >= (existing["created_at"] or ""):
                # Smart merge: take the higher recall_count (more progress = keep)
                conn.execute(
                    """UPDATE cards SET summary=?, personal=?, tags=?, image_url=?,
                       status=?, recall_enabled=?, batch_id=?,
                       last_recalled=?, recall_count=max(recall_count, ?),
                       next_recall=?, recall_interval=?, difficulty=?,
                       recall_seconds=max(recall_seconds, ?)
                       WHERE id=?""",
                    (cd.get("summary", ""), cd.get("personal", ""),
                     json.dumps(cd.get("tags", []), ensure_ascii=False),
                     cd.get("image_url", ""), in_status,
                     int(cd.get("recall_enabled", False)), cd.get("batch_id", ""),
                     cd.get("last_recalled"), cd.get("recall_count", 0),
                     cd.get("next_recall"), cd.get("recall_interval", 1),
                     cd.get("difficulty", 0), cd.get("recall_seconds", 0),
                     existing["id"]),
                )
                updated += 1
            else:
                skipped += 1
        else:
            conn.execute(
                """INSERT INTO cards
                   (scene_type, title, summary, personal, source_kind, source_ref,
                    image_url, tags, source_date, status, recall_enabled, batch_id, created_at,
                    last_recalled, recall_count, next_recall, recall_interval, difficulty, recall_seconds)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cd.get("scene_type", "custom"), title,
                 cd.get("summary", ""), cd.get("personal", ""),
                 cd.get("source_kind", "text"), cd.get("source_ref", ""),
                 cd.get("image_url", ""),
                 json.dumps(cd.get("tags", []), ensure_ascii=False),
                 source_date or datetime.now().strftime("%Y-%m-%d"),
                 cd.get("status", "confirmed"), int(cd.get("recall_enabled", False)),
                 cd.get("batch_id", ""),
                 cd.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M"),
                 cd.get("last_recalled"), cd.get("recall_count", 0),
                 cd.get("next_recall"), cd.get("recall_interval", 1),
                 cd.get("difficulty", 0), cd.get("recall_seconds", 0)),
            )
            imported += 1

    # Import narratives (skip by title to avoid duplicates)
    for narr in snapshot.get("narratives", []):
        title = narr.get("title", "")
        exists = conn.execute(
            "SELECT id FROM narratives WHERE title = ?", (title,)
        ).fetchone()
        if not exists:
            conn.execute(
                """INSERT INTO narratives (title, body, date_start, date_end, ai_used, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (title, narr.get("body", ""), narr.get("date_start"),
                 narr.get("date_end"), int(narr.get("ai_used", False)),
                 narr.get("created_at")),
            )

    # Import folders (upsert by folder_id, keep user-chosen names)
    for fd in snapshot.get("folders", []):
        fid = fd.get("folder_id")
        if not fid:
            continue
        exists = conn.execute(
            "SELECT folder_id FROM folders WHERE folder_id = ?", (fid,)
        ).fetchone()
        if exists:
            incoming = (fd.get("name") or "").strip()
            if incoming:
                conn.execute(
                    "UPDATE folders SET name = ? WHERE folder_id = ?", (incoming, fid)
                )
        else:
            conn.execute(
                """INSERT INTO folders (folder_id, name, scene_type, source_date, created_at)
                   VALUES (?,?,?,?,?)""",
                (fid, fd.get("name", ""), fd.get("scene_type", "custom"),
                 fd.get("source_date"), fd.get("created_at")),
            )

    # Import AI connections (order-normalised so (a,b)==(b,a))
    for ac in snapshot.get("ai_connections", []):
        a, b = int(ac.get("a", 0)), int(ac.get("b", 0))
        if not a or not b or a == b:
            continue
        lo, hi = min(a, b), max(a, b)
        reason = ac.get("reason", "")
        exists = conn.execute(
            "SELECT id FROM ai_connections WHERE card_a=? AND card_b=? AND reason=?",
            (lo, hi, reason),
        ).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO ai_connections (card_a, card_b, reason) VALUES (?,?,?)",
                (lo, hi, reason),
            )

    conn.commit()
    conn.close()
    return imported, updated, skipped
