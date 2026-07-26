"""LLM integration - Qwen-VL / OpenAI compatible, with fallback to pre-generated mode."""

import os
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
    safe = Path(filename).name.replace(" ", "_")
    path = UPLOAD_DIR / safe
    path.write_bytes(content_bytes)
    return f"/static/uploads/{safe}"


def _build_prompt(scene_key, personalization):
    scenario = get_scenario(scene_key)
    parts = []
    parts.append("You are a cognitive assistant. The user just finished collecting materials in a '" + scenario["name"] + "' scene.")
    parts.append("Your task: filter the materials and generate memory cards for what is truly worth keeping long-term.")
    parts.append("Selection criteria: high information density, unique insight, long-term value. Discard repetition, marketing fluff, low-value details.")
    if personalization:
        parts.append("User note: " + personalization + " - prioritize content matching the user's stated direction.")
    parts.append("Scene focus: " + scenario["focus_prompt"])
    parts.append("For each card generate: title (one-line objective summary), summary (2-3 sentence description), personal (one sentence on why it matters to the user), tags (2-3).")
    parts.append("Return only cards worth keeping, count is flexible.")
    parts.append('Return strictly as JSON: {"cards": [{"title":"...","summary":"...","personal":"...","tags":["..."]}]}')
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
        json=body, headers={"Authorization": "Bearer " + api_key}, timeout=60,
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
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
    }
    r = httpx.post(base_url + "/chat/completions", json=body,
                   headers={"Authorization": "Bearer " + api_key}, timeout=60)
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
        elif kind == "audio":
            title = "语音记录：" + Path(name).stem
            summary = "用户在「" + scenario["name"] + "」场景中录制的音频片段。"
            tags = [scenario["name"][:2], "录音"]
        else:
            title = ref[:40] if len(ref) > 40 else (ref or "备注 " + str(i + 1))
            summary = ref
            tags = [scenario["name"][:2], "文字"]
        personal = personalization or "——（可在确认时编辑个人感受）"
        cards.append({
            "title": title, "summary": summary, "personal": personal,
            "tags": tags, "source_kind": kind, "source_ref": ref,
            "image_url": m.get("url", ""),
        })
    return cards


def analyze_materials(materials, scene_key, personalization=""):
    image_paths = [m["url"] for m in materials if m["kind"] == "image" and m.get("url")]
    text_parts = [m["ref"] for m in materials if m["kind"] == "text" and m.get("ref")]
    text_content = "\n".join(text_parts)
    try:
        if _has_dashscope_key() and image_paths:
            cards = _call_dashscope_vision(image_paths, text_content, scene_key, personalization)
        elif _has_openai_key() and image_paths:
            cards = _call_openai_vision(image_paths, text_content, scene_key, personalization)
        else:
            cards = _fallback_generate(materials, scene_key, personalization)
    except Exception as e:
        print("[LLM] call failed, falling back: " + str(e))
        cards = _fallback_generate(materials, scene_key, personalization)
    for i, c in enumerate(cards):
        if i < len(materials) and not c.get("image_url") and materials[i]["kind"] == "image":
            c["image_url"] = materials[i].get("url", "")
        if i < len(materials) and not c.get("source_kind"):
            c["source_kind"] = materials[i]["kind"]
    return cards
