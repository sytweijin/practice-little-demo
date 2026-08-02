"""LLM integration - Qwen-VL / OpenAI compatible, with fallback to pre-generated mode."""

import os
import re
import urllib.parse
import time
import base64
import json
import httpx
from pathlib import Path
from scenarios import get_scenario

UPLOAD_DIR = Path(__file__).parent / "static" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _has_dashscope_key():
    return bool(os.getenv("DASHSCOPE_API_KEY"))


def _has_openai_key():
    return bool(os.getenv("OPENAI_API_KEY"))


def save_upload(filename, content_bytes):
    # URL-decode the filename (browsers may URL-encode Chinese characters)
    raw = urllib.parse.unquote(filename)
    # Keep only safe filename characters
    safe = re.sub(r"[^a-zA-Z0-9._\-一-鿿]", "", Path(raw).name).replace(" ", "_")
    if not safe:
        safe = "upload_" + str(int(time.time()))
    # Add timestamp to prevent collisions
    ts = str(int(time.time()))
    name_parts = Path(safe).stem[:40]
    ext = Path(safe).suffix
    safe = name_parts + "_" + ts + ext
    path = UPLOAD_DIR / safe
    path.write_bytes(content_bytes)
    return f"/static/uploads/{safe}"


def _transcribe_audio(audio_url):
    """Transcribe audio/video so its content reaches the LLM text channel.
    DashScope: native async ASR (submit + poll) because the OpenAI-compatible
    /audio/transcriptions endpoint returns 404 on DashScope.
    OpenAI: standard /audio/transcriptions (whisper-1).
    Returns empty string when no key is configured or the call fails."""
    full = Path(__file__).parent / audio_url.lstrip("/")
    if not full.exists():
        return ""
    api_key = os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return ""
    try:
        if _has_dashscope_key():
            result = _dashscope_asr(full, audio_url)
            if result.startswith("__ASR_FAILED__:"):
                reason = result.split(":", 1)[1]
                raise RuntimeError("ASR: " + reason)
            return result
        # Real OpenAI (or truly OpenAI-compatible provider)
        base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        with full.open("rb") as fh:
            files = {"file": (full.name, fh, "application/octet-stream")}
            r = httpx.post(base_url + "/audio/transcriptions",
                headers={"Authorization": "Bearer " + api_key},
                files=files, data={"model": "whisper-1"}, timeout=120)
            r.raise_for_status()
            return str(r.json().get("text", "")).strip()
    except RuntimeError:
        raise  # let ASR-specific errors (no speech etc.) reach the caller
    except Exception as e:
        print("[ASR] transcription failed for " + audio_url + ": " + str(e))
    return ""


def _dashscope_asr(full, audio_url):
    """DashScope native async recording-file ASR.
    The OpenAI-compatible /audio/transcriptions returns 404 on DashScope, so we
    use the native submit+poll flow: POST .../audio/asr/transcription with a
    base64 data URI, then GET .../tasks/{id} until done, then fetch the result
    JSON whose transcripts[0].text holds the transcript."""
    api_key = os.getenv("DASHSCOPE_API_KEY")
    model = os.getenv("DASHSCOPE_ASR_MODEL", "paraformer-v2")
    b64 = base64.b64encode(full.read_bytes()).decode()
    ext = full.suffix.lower()
    mime = "audio/webm" if ext in (".webm", ".weba") else (
        "audio/mp4" if ext == ".m4a" else ("audio/" + ext.lstrip(".")))
    file_url = "data:" + mime + ";base64," + b64
    sub = httpx.post(
        "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
        headers={"Authorization": "Bearer " + api_key, "X-DashScope-Async": "enable"},
        json={"model": model, "input": {"file_urls": [file_url]},
              "parameters": {"language_hints": ["zh", "en"]}},
        timeout=60,
    )
    sub.raise_for_status()
    task_id = sub.json().get("output", {}).get("task_id")
    if not task_id:
        return ""
    for _ in range(30):
        time.sleep(2)
        pr = httpx.get("https://dashscope.aliyuncs.com/api/v1/tasks/" + task_id,
                       headers={"Authorization": "Bearer " + api_key}, timeout=30)
        pr.raise_for_status()
        st = pr.json().get("output", {}).get("task_status")
        if st == "SUCCEEDED":
            results = pr.json()["output"].get("results", [])
            if not results:
                return ""
            turl = results[0].get("transcription_url")
            if not turl:
                return ""
            rj = httpx.get(turl, timeout=30).json()
            transcripts = rj.get("transcripts", [])
            return str(transcripts[0].get("text", "")).strip() if transcripts else ""
        if st == "FAILED":
            code = pr.json().get("output", {}).get("code", "FAILED")
            # SUCCESS_WITH_NO_VALID_FRAGMENT = processed OK but no speech detected
            reason = ("no_valid_fragment" if "NO_VALID_FRAGMENT" in code
                      else code.lower())
            print("[ASR] DashScope task FAILED for " + audio_url + ": " + code)
            return "__ASR_FAILED__:" + reason
    print("[ASR] DashScope task timed out for " + audio_url)
    return ""
def _build_prompt(scene_key, personalization):
    scenario = get_scenario(scene_key)
    parts = []
    parts.append("You are a cognitive assistant. The user just finished collecting materials in a '" + scenario["name"] + "' scene.")
    parts.append("Your task: filter the materials and generate memory cards for what is truly worth keeping long-term.")
    parts.append("Selection criteria: high information density, unique insight, long-term value. Discard repetition, marketing fluff, low-value details.")
    if personalization:
        parts.append("User note: " + personalization + " - prioritize content matching the user's stated direction.")
    parts.append("Scene focus: " + scenario["focus_prompt"])
    parts.append("For each card generate: title (one-line objective summary), summary (2-3 sentence description), tags (2-3). Do NOT generate a personal-attribution field; that is reserved for the user.")
    parts.append("Return only cards worth keeping, count is flexible.")
    parts.append('Return strictly as JSON: {"cards": [{"title":"...","summary":"...","tags":["..."]}]}')
    return "\n".join(parts)


def _call_dashscope_vision(image_paths, text_content, scene_key, personalization):
    api_key = os.getenv("DASHSCOPE_API_KEY")
    sys_prompt = _build_prompt(scene_key, personalization)
    content = []
    for img_path in image_paths:
        full = Path(__file__).parent / img_path.lstrip("/")
        if full.exists():
            b64 = base64.b64encode(full.read_bytes()).decode()
            content.append({"image": "data:image/jpeg;base64," + b64})
    if text_content:
        content.append({"text": "Text notes:\n" + text_content})
    content.append({"text": "Analyze the above materials and generate memory cards per the system prompt."})
    body = {
        "model": "qwen3.7-plus",
        "input": {"messages": [
            {"role": "system", "content": [{"text": sys_prompt}]},
            {"role": "user", "content": content},
        ]},
        "parameters": {"result_format": "message"},
    }
    r = httpx.post(
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        json=body, headers={"Authorization": "Bearer " + api_key}, timeout=180,
    )
    r.raise_for_status()
    data = r.json()
    text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    return _parse_json(text)


def _call_openai_vision(image_paths, text_content, scene_key, personalization):
    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    sys_prompt = _build_prompt(scene_key, personalization)
    content = [{"type": "text", "text": sys_prompt}]
    for img_path in image_paths:
        full = Path(__file__).parent / img_path.lstrip("/")
        if full.exists():
            b64 = base64.b64encode(full.read_bytes()).decode()
            content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}})
    if text_content:
        content.append({"type": "text", "text": "Text notes:\n" + text_content})
    body = {
        "model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o"),
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
    }
    r = httpx.post(base_url + "/chat/completions", json=body,
                   headers={"Authorization": "Bearer " + api_key}, timeout=180)
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"]
    return _parse_json(text)


def _parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text).get("cards", [])


def _fallback_generate(materials, scene_key, personalization):
    scenario = get_scenario(scene_key)
    cards = []
    for i, m in enumerate(materials):
        kind = m.get("kind", "text")
        ref = m.get("ref", "")
        name = m.get("name", "material" + str(i + 1))
        if kind == "image":
            title = "图像记录：" + Path(name).stem
            summary = "用户在「" + scenario["name"] + "」场景中拍摄的照片。"
            tags = [scenario["name"][:2], "图像"]
        elif kind == "video":
            title = "视频记录：" + Path(name).stem
            summary = "用户在「" + scenario["name"] + "」场景中录制的视频片段。"
            tags = [scenario["name"][:2], "视频"]
        elif kind == "audio":
            title = "音频记录：" + Path(name).stem
            summary = "用户在「" + scenario["name"] + "」场景中录制的音频。ASR 未识别到语音内容（可能是音乐、环境音等非言语音频），请补充描述这段音频的内容与意义。"
            tags = [scenario["name"][:2], "音频"]
        else:
            title = ref[:40] if len(ref) > 40 else (ref or "备注 " + str(i + 1))
            summary = ref
            tags = [scenario["name"][:2], "文字"]
        personal = ""  # reserved for the user; AI never fills personal attribution
        cards.append({
            "title": title, "summary": summary, "personal": personal,
            "tags": tags, "source_kind": kind, "source_ref": ref,
            "image_url": m.get("url", ""),
        })
    return cards


def analyze_materials(materials, scene_key, personalization=""):
    # Frames (kind="frame") are browser-extracted video keyframes: they feed
    # the vision API so the AI can "see" the video, but they never become
    # standalone cards. The video file itself is the primary material.
    frame_paths = [m["url"] for m in materials if m["kind"] == "frame" and m.get("url")]
    image_paths = [m["url"] for m in materials if m["kind"] == "image" and m.get("url")]
    vision_paths = image_paths + frame_paths

    video_materials = [m for m in materials if m["kind"] == "video"]

    # Transcribe audio/video so their content reaches the LLM text channel
    audio_texts = []
    for m in materials:
        kind = m.get("kind", "")
        if kind in ("audio", "video") and m.get("url"):
            try:
                transcript = _transcribe_audio(m["url"])
            except RuntimeError:
                transcript = ""
            if transcript:
                label = "\u89c6\u9891\u8f6c\u5199" if kind == "video" else "\u8bed\u97f3\u8f6c\u5199"
                audio_texts.append("[" + label + "] " + transcript)
            m["ref"] = transcript
    text_parts = [m["ref"] for m in materials if m["kind"] == "text" and m.get("ref")]
    text_parts = audio_texts + text_parts
    text_content = "\n".join(text_parts)

    # Materials for card creation exclude frames entirely
    card_materials = [m for m in materials if m["kind"] != "frame"]

    ai_used = False
    ai_error = None  # real error when a key WAS present but the call failed
    try:
        if vision_paths and _has_dashscope_key():
            cards = _call_dashscope_vision(vision_paths, text_content, scene_key, personalization)
            ai_used = True
        elif vision_paths and _has_openai_key():
            cards = _call_openai_vision(vision_paths, text_content, scene_key, personalization)
            ai_used = True
        elif text_content and (_has_dashscope_key() or _has_openai_key()):
            cards = _call_text_llm_for_cards(text_content, scene_key, personalization)
            ai_used = True
        else:
            # Key is configured but there is nothing for AI to analyze (e.g.
            # non-speech audio: music, ambient sound, or no clear voice).
            # Don't report an error — just generate placeholder cards so the
            # user can add their own description later.
            cards = _fallback_generate(card_materials, scene_key, personalization)
            if (_has_dashscope_key() or _has_openai_key()) and not text_content and not vision_paths:
                ai_error = "NOT_AN_ERROR"  # sentinel: placeholder cards for non-text content
    except Exception as e:
        # Only attribute the failure to "no key" when a key is genuinely absent.
        # If a key WAS present, this is a real call error (bad model / network /
        # quota) and must be surfaced instead of being disguised as "未接入 AI".
        if _has_dashscope_key() or _has_openai_key():
            ai_error = str(e)[:300]
        cards = _fallback_generate(card_materials, scene_key, personalization)

    # Assign media URLs to AI-generated cards by position.
    # For video materials, image_url points to the video file itself so the
    # frontend renders a <video> player.  Frames are never assigned to cards.
    for i, c in enumerate(cards):
        if i < len(card_materials):
            m = card_materials[i]
            if not c.get("source_kind"):
                c["source_kind"] = m["kind"]
            if m["kind"] == "image" and not c.get("image_url"):
                c["image_url"] = m.get("url", "")
            elif m["kind"] == "video" and not c.get("image_url"):
                c["image_url"] = m.get("url", "")
        elif video_materials and not c.get("image_url"):
            # Extra AI cards beyond material count: associate with first video
            c["image_url"] = video_materials[0].get("url", "")
            if not c.get("source_kind"):
                c["source_kind"] = "video"
    return cards, ai_used, ai_error


def _call_text_llm_for_cards(text_content, scene_key, personalization=""):
    """Generate memory cards from text-only content (no images).
    Used when the user uploads video/audio/notes but no images."""
    sys_prompt = _build_prompt(scene_key, personalization)
    prompt = (
        sys_prompt + "\n\n"
        "The user provided text-based materials (notes, transcripts, or audio transcriptions). Here is the content:\n"
        + text_content + "\n\n"
        "Generate 1-3 memory cards capturing the key knowledge, insights, or facts in this text. "
        "Even brief notes contain worth-keeping information - do not return an empty list."
    )
    text = _call_text_llm(prompt)
    if not text:
        return []
    return _parse_json(text)


def _call_text_llm(prompt):
    """Call a text-only LLM (no vision needed).
    Uses DashScope compatible mode or OpenAI, whichever key is configured.
    Returns the raw text response, or None if no key / call fails."""
    if _has_dashscope_key():
        api_key = os.getenv("DASHSCOPE_API_KEY")
        base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
        model = os.getenv("DASHSCOPE_TEXT_MODEL", "qwen-plus")
    elif _has_openai_key():
        api_key = os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
        model = os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")
    else:
        return None
    try:
        body = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }
        r = httpx.post(
            base_url + "/chat/completions", json=body,
            headers={"Authorization": "Bearer " + api_key}, timeout=90,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print("[LLM-text] call failed: " + str(e))
        return None


def _parse_json_key(text, key):
    """Parse JSON from LLM output, return the value of a given top-level key."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    data = json.loads(text)
    return data.get(key, [])


def discover_connections(cards):
    """Ask the LLM to find non-obvious conceptual links between cards.
    Returns (pairs, ai_used) where pairs is a list of {a, b, reason}."""
    if not _has_dashscope_key() and not _has_openai_key():
        return [], False
    compact = []
    for c in cards[:60]:
        compact.append({
            "id": c["id"],
            "title": c["title"],
            "summary": (c.get("summary") or "")[:150],
            "tags": c.get("tags") or [],
            "scene": c.get("scene_type") or "custom",
        })
    prompt = (
        "You are a cognitive assistant. The user collected memory cards across different scenes.\n"
        "Below are their cards:\n" + json.dumps(compact, ensure_ascii=False) + "\n\n"
        "Find 3-8 non-obvious conceptual connections between cards from DIFFERENT scenes.\n"
        "A good connection reveals a hidden pattern, shared theme, or cross-scene insight "
        "that the user might not have noticed.\n"
        "Write the reason in Chinese, one sentence each.\n"
        'Return strictly as JSON: {"connections": [{"a": <int card_id>, "b": <int card_id>, "reason": "..."}]}'
    )
    text = _call_text_llm(prompt)
    if not text:
        return [], False
    try:
        pairs = _parse_json_key(text, "connections")
    except Exception:
        pairs = []
    valid = []
    ids = {c["id"] for c in cards}
    for p in pairs:
        a, b = p.get("a"), p.get("b")
        if a in ids and b in ids and a != b and p.get("reason"):
            valid.append({"a": int(a), "b": int(b), "reason": str(p["reason"])})
    return valid, True


def generate_narrative(cards, date_label):
    """Ask the LLM to weave cards into a themed retrospective narrative.
    Returns (narrative_dict, ai_used)."""
    if not _has_dashscope_key() and not _has_openai_key():
        return None, False
    compact = []
    for c in cards:
        compact.append({
            "title": c["title"],
            "summary": (c.get("summary") or "")[:200],
            "personal": (c.get("personal") or "")[:150],
            "scene": c.get("scene_type") or "custom",
            "date": c.get("source_date") or "",
            "tags": c.get("tags") or [],
        })
    prompt = (
        "You are a reflective writing assistant. The user collected memory cards during: " + date_label + "\n"
        "Below are their cards:\n" + json.dumps(compact, ensure_ascii=False) + "\n\n"
        "Write a warm, reflective narrative in Chinese (400-600 chars) that weaves these "
        "memories into a coherent story, organized by theme rather than chronology.\n"
        "Use second person. Highlight the personal growth and cross-scene insights.\n"
        "Return strictly as JSON: {\"title\": \"...\", \"body\": \"...\"}"
    )
    text = _call_text_llm(prompt)
    if not text:
        return None, False
    try:
        result = _parse_json_key(text, "title")  # just to parse JSON
        raw = text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        s, e = raw.find("{"), raw.rfind("}")
        data = json.loads(raw[s:e+1]) if s >= 0 else {}
        title = data.get("title", date_label + " 回顾")
        body = data.get("body", "")
        return {"title": str(title), "body": str(body)}, True
    except Exception as ex:
        print("[Narrative] parse failed: " + str(ex))
        return None, False
