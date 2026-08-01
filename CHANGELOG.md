# CHANGELOG

本文件记录"在场 — AI 记忆工坊"的重要变更。格式遵循团队约定：每条记录包含问题 / 修改前 / 修改后 / 为什么这样改 / 收益，按优先级分组。

---

## v1.0 -- 修复 AI 拆解失败：视觉调用超时 + 真实错误暴露（2026-08-02）

**定位：** 上传照片/视频后一律报"AI 拆解失败"。根因是视觉调用超时（60s 对推理模型不够）+ 调用失败被静默吞掉后前端误报"未接入 AI"，导致无法定位真实原因。本次彻底修复并让失败原因如实暴露。

### P0（关键缺陷）

#### 1. 视觉调用超时 60s，推理模型必然超时 → AI 拆解失败

**问题：** 视觉理解走的是 `qwen3.7-plus`，一个带"思考"的推理模型，单张照片实际耗时约 40s。但 `_call_dashscope_vision` / `_call_openai_vision` 的 httpx 超时写死 `timeout=60`。单张照片压在超时边缘（图稍大或网络抖动即超），视频路径需送多帧 + 先做 ASR，几乎必然超过 60s 触发 `ReadTimeout`，前端显示"AI 拆解失败：The read operation timed out"。

**修改前：**
```python
# llm.py — 两个视觉调用均写死 60s
r = httpx.post(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    json=body, headers={"Authorization": "Bearer " + api_key}, timeout=60,
)
# _call_openai_vision 同样
r = httpx.post(base_url + "/chat/completions", json=body,
               headers={"Authorization": "Bearer " + api_key}, timeout=60)
```

**修改后：**
```python
# llm.py — 提升到 180s，覆盖推理模型 + 多帧 + ASR 的总耗时
r = httpx.post(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    json=body, headers={"Authorization": "Bearer " + api_key}, timeout=180,
)
r = httpx.post(base_url + "/chat/completions", json=body,
               headers={"Authorization": "Bearer " + api_key}, timeout=180)
```

**为什么这样改：** 用真实上传的素材逐层验证过：单图约 40s、3 图约 52s、视频（含 ASR）约 47s 成功——全部在 60s 之外、180s 之内。60s 对推理模型是结构性不足，不是偶发抖动。保持 180s 而非更长，避免无响应时让用户空等过久。

**收益：**
- 照片/视频上传后 AI 拆解恢复正常，不再因超时报错
- 实测同一视频从"超时失败"变为"47s 成功生成 2 张卡片"

#### 2. API 调用失败被静默吞掉，前端误报"未接入 AI"

**问题：** `analyze_materials` 捕获异常后只 `print` 日志、返回 `ai_used=False`，前端一律显示"未接入 AI，配置 API Key 后可启用"。于是即便用户已正确配置 Key，任何真实调用错误（超时、模型名、配额）都被伪装成"未配置"，无从排查。这正是本次问题长期无法定位的直接原因。

**修改前：**
```python
# llm.py — 失败原因丢失，统一回退
except Exception as e:
    print("[LLM] call failed, falling back: " + str(e))
    cards = _fallback_generate(card_materials, scene_key, personalization)
...
return cards, ai_used   # 无错误信息字段
```
```javascript
// app.js — 不区分"无 Key"与"Key 存在但调用失败"
function renderDraftCards(drafts, minutes, aiSeconds, aiUsed) {
  let aiLabel = (aiUsed === false) ? "⚠️ 未接入 AI，配置 API Key 后可启用..." : "...";
}
```

**修改后：**
```python
# llm.py — 仅当 Key 真正缺失才视为"未接入"，否则保留真实错误
except Exception as e:
    if _has_dashscope_key() or _has_openai_key():
        ai_error = str(e)[:300]
    cards = _fallback_generate(card_materials, scene_key, personalization)
...
return cards, ai_used, ai_error
```
```javascript
// app.js — 三态：成功 / 有 Key 但调用失败 / 无 Key
function renderDraftCards(drafts, minutes, aiSeconds, aiUsed, aiError) {
  if (aiUsed === false && aiError) {
    aiLabel = "⚠️ AI 调用失败：" + aiError + " · 请检查 API Key/模型名/网络";
  } else if (aiUsed === false) {
    aiLabel = "⚠️ 未接入 AI，配置 API Key 后可启用";
  } else { ... }
}
```

**为什么这样改：** "未接入 AI"和"调用失败"是两类完全不同的问题，前者需用户配置 Key，后者需排查模型/网络/配额。混为一谈会让用户在 Key 已正确配置时仍误以为是配置问题。`ai_error` 链路（llm.py → main.py → app.js）让真实原因直达界面。

**收益：**
- 失败原因直接显示在卡片区，无需查服务器日志即可定位
- 不再把真实调用错误误导成"未配置"

### P1（健壮性提升）

#### 3. load_dotenv 不 override，进程残留空 Key 覆盖 .env

**问题：** `load_dotenv()` 默认不覆盖进程已有环境变量。若启动 shell 中残留空的 `DASHSCOPE_API_KEY`（或从污染的环境继承），.env 中的正确值无法生效，服务器进程实际拿到空 Key，于是 `_has_dashscope_key()` 返回 False，直接走占位卡片——表现为"明明配了 Key 却不调用 AI"。

**修改前：**
```python
# main.py — 默认不覆盖已有（可能为空的）环境变量
load_dotenv()
```

**修改后：**
```python
# main.py — .env 始终覆盖进程中可能残留的空值
load_dotenv(override=True)
```

**为什么这样改：** .env 是配置的唯一事实来源。若用户已在 .env 写入正确 Key，理应始终生效，不应被一个意外存在的空环境变量否决。

**收益：**
- 修正 .env 后重启即可生效，不再受进程残留环境干扰

#### 4. 视频抽帧用全分辨率，放大超时与带宽风险

**问题：** 浏览器抽帧时 `canvas` 直接设为 `video.videoWidth × video.videoHeight`，手机视频常为 1080p/4K。全分辨率帧体积大、视觉 API 处理慢，是视频路径频繁超时的放大因素。

**修改前：**
```javascript
// app.js — 帧为原始分辨率
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
```

**修改后：**
```javascript
// app.js — 缩放到最大 720px 宽，保持宽高比
var maxW = 720;
var scale = Math.min(1, maxW / video.videoWidth);
canvas.width = Math.round(video.videoWidth * scale);
canvas.height = Math.round(video.videoHeight * scale);
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
```

**为什么这样改：** 视觉模型对缩略图的理解力足够（卡片只需标题/摘要/标签，无需像素级细节）。720px 在清晰度与处理速度间取得平衡，显著降低单帧体积和 API 耗时，配合 P0 的超时提升双保险。

**收益：**
- 视频帧体积大幅下降，视觉 API 响应更快、更稳定
- 减少上传带宽（移动端尤其明显）

---
## v0.9 -- 视频理解管线重构（2026-08-01）

**定位：** 让视频素材真正被 AI 理解并作为视频保存，而非拆成一堆照片卡片。核心改动：浏览器抽帧只作为 AI 视觉输入（不产生独立卡片），视频本体是主要素材并生成带播放器的视频卡片。

### P0（关键缺陷）

#### 1. 视频被拆成多张图片卡片，视频本体丢失

**问题：** 浏览器端抽出的视频关键帧被当作普通图片文件发送（`files` 字段），后端将每帧分类为 `kind: "image"`，于是每帧各生成一张图片卡，视频文件本身反而被过滤丢弃。用户上传一个视频，得到的是 3 张照片卡片而非 1 张视频卡片。

**修改前：**
```javascript
// app.js — 帧被混入 sendFiles，与原始文件一起发送
var sendFiles = selectedFiles.slice();
sendFiles = sendFiles.concat(vframes);
for (const f of sendFiles) fd.append("files", f);
```
```python
# llm.py — 视频因"有帧"而被删除，帧变成独立素材
has_frames = any(m["kind"] == "image" for m in materials)
if has_frames:
    materials = [m for m in materials if m.get("kind") != "video"]
```

**修改后：**
```javascript
// app.js — 帧发送到独立字段 video_frames，不混入 files
var allFrames = [];
allFrames = allFrames.concat(vframes);
for (const f of sendFiles) fd.append("files", f);
for (const f of allFrames) fd.append("video_frames", f);
```
```python
# main.py — video_frames 分类为 kind="frame"（内部类型，不产生卡片）
for f in video_frames:
    materials.append({"kind": "frame", ...})

# llm.py — 帧只进视觉 API 输入，不参与卡片生成
frame_paths = [m["url"] for m in materials if m["kind"] == "frame"]
vision_paths = image_paths + frame_paths  # AI 看到帧 = "看到"视频
card_materials = [m for m in materials if m["kind"] != "frame"]  # 卡片只来自真实素材
```

**为什么这样改：** 帧的作用是让 AI "看见"视频的画面内容，但最终存储的应该是视频本身。将帧和素材分离到不同字段，从根本上避免了帧变成独立卡片的问题。视频卡片的 `image_url` 指向视频文件路径，前端已有的 `isVideoUrl()` 函数会自动渲染 `<video>` 播放器。

**收益：**
- 上传视频后得到的是带播放器的视频卡片，不再是多张照片
- 帧仍然让 AI 理解了视频画面内容（视觉 API 照常分析）
- 帧不污染卡片数量和素材计数

#### 2. AI 卡片的 image_url 丢失（v0.8 回归）

**问题：** v0.8 重构 `analyze_materials` 时移除了 `image_url` 位置映射，导致 LLM 返回的卡片没有图片 URL（因为 LLM JSON 不知道本地文件路径）。卡片不显示图片，视频 URL 也无法附加。

**修改前：**
```python
# llm.py — 只赋 source_kind，image_url 遗漏
for i, c in enumerate(cards):
    if i < len(materials) and not c.get("source_kind"):
        c["source_kind"] = materials[i]["kind"]
```

**修改后：**
```python
# llm.py — 恢复 image_url 位置映射，视频素材指向视频文件本身
for i, c in enumerate(cards):
    if i < len(card_materials):
        m = card_materials[i]
        if m["kind"] == "image" and not c.get("image_url"):
            c["image_url"] = m.get("url", "")
        elif m["kind"] == "video" and not c.get("image_url"):
            c["image_url"] = m.get("url", "")  # 前端渲染 <video>
```

**为什么这样改：** LLM 返回的 JSON 不包含本地路径，必须在后端通过位置映射补全。视频卡片的 `image_url` 设为视频文件 URL，前端 `isVideoUrl()` 检测到 `.mp4` 等扩展名后自动渲染播放器。

**收益：**
- AI 路径的卡片重新正确显示媒体（图片或视频）
- 视频卡片可直接播放原始视频

#### 3. 视频音频未进入 AI 文本通道

**问题：** 视频的音频内容（对话、讲解）完全没有被转写，AI 只能看到画面但听不到声音，理解质量受限。

**修改前：**
```python
# llm.py — 只有 audio 类型走 ASR
if m.get("kind") == "audio" and m.get("url"):
    transcript = _transcribe_audio(m["url"])
```

**修改后：**
```python
# llm.py — audio 和 video 都走 ASR 转写
if kind in ("audio", "video") and m.get("url"):
    transcript = _transcribe_audio(m["url"])
    label = "视频转写" if kind == "video" else "语音转写"
```

**为什么这样改：** 视频的画面和声音承载不同维度的信息。帧让 AI "看到"展品外观，ASR 让 AI "听到"讲解内容，双路径合并后 AI 能生成更完整的记忆卡片。

**收益：**
- 视频的语音内容（如讲解员解说）被提取并融入 AI 分析
- 文本通道作为视觉通道的补充，提升卡片质量

### P1（健壮性提升）

#### 4. 纯文本/纯语音路径的 LLM 提示词过于严格

**问题：** `_call_text_llm_for_cards` 复用了 `_build_prompt`（"筛选值得留存的内容"），导致 LLM 对简短文本笔记返回空卡片列表（`{"cards": []}`），用户看到"AI 筛选出 0 条"。

**修改前：**
```python
"Generate memory cards from this content."
```

**修改后：**
```python
"Generate 1-3 memory cards capturing the key knowledge, insights, or facts in this text. "
"Even brief notes contain worth-keeping information - do not return an empty list."
```

**为什么这样改：** 视觉路径有图片作为丰富输入，LLM 容易找到值得留存的内容。但纯文本路径输入较少，如果 prompt 仍然强调"筛选"，LLM 会过度过滤。调整为"提取关键知识"更匹配文本场景。

**收益：** 纯文字备注、语音转写也能生成有意义的卡片。

#### 5. fallback 模式中视频标题误写为"图像记录"

**问题：** `_fallback_generate` 将 `video` 和 `image` 归入同一分支，视频卡片的标题和摘要都写成"拍摄的照片"。

**修改前：**
```python
if kind in ("image", "video"):
    title = "图像记录：" + Path(name).stem
```

**修改后：**
```python
if kind == "image":
    title = "图像记录：" + Path(name).stem
elif kind == "video":
    title = "视频记录：" + Path(name).stem
```

**收益：** fallback 卡片文案与素材类型一致。

#### 6. 素材计数包含抽帧图片，虚增"节省分钟数"

**问题：** `materials_count` 和 `minutes_saved` 包含 `kind: "frame"` 的抽帧图片，3 帧让计数虚增 3。

**修改前：**
```python
minutes = len(materials) * scenario["minutes_per_material"]
```

**修改后：**
```python
real_count = len([m for m in materials if m["kind"] != "frame"])
minutes = real_count * scenario["minutes_per_material"]
```

**收益：** 统计数据准确反映用户真实素材数量。

### P2（体验优化）

#### 7. 默认场景从第二个改为第一个

**修改前：** `let selectedScenario = "enterprise";`
**修改后：** `let selectedScenario = "museum";`

#### 8. 跳过全部草稿卡后残留空文案

**修改前：** 只删除卡片元素，容器标题残留。
**修改后：** 最后一张卡删除后清空整个容器。

---

## v0.8 -- AI 联结、叙事回顾与真实可用性（2026-08-01）

**定位：** 从"单机记忆工具"进化为"有认知深度的个人记忆系统"。新增 AI 跨场景联结发现（增量+锁定）、月度叙事回顾、跨设备智能同步，并修复影响信任度的数据保真与诚实度问题。

**审查/修改背景：** 产品功能基本完成后，审查发现三类问题：配了 Key 的真实 AI 能力未走通、导出/导入丢失回忆进度、回退模式伪装成 AI 结论。同时需要提升立意高度——让 AI 不只是"帮你记了"，而是诚实地表达人与 AI 的协作关系。

### P0（关键缺陷）

#### 1. 视频素材发送给视觉 API 导致必报错回退

**问题：** `analyze_materials` 把 `video` 也当图片塞进 base64 发给视觉模型，任何模型都会拒绝，静默回退到模板生成。

**修改前：**
```python
# llm.py — video 和 image 混在一起当图片发
image_paths = [m["url"] for m in materials if m["kind"] in ("image", "video") and m.get("url")]
```

**修改后：**
```python
# llm.py — 只有图片进视觉通道，视频仅归档
image_paths = [m["url"] for m in materials if m["kind"] == "image" and m.get("url")]
```

**为什么这样改：** 视觉 API 不接收视频文件。把视频当图片发必然报错，异常被 catch 后静默回退到模板，用户以为"AI 分析了"实际什么都没发生。

**收益：** 配了 Key 时图片分析真正走通；视频不再制造假阳性回退。

#### 2. 导出/导入丢失回忆进度

**问题：** `export_cards_data` 导出了全部 19 个字段，但 `import_cards` 只插入固定子集，6 个回忆字段被丢弃。

**修改前：**
```python
# memory.py — 只插入部分字段
conn.execute(
    "INSERT INTO cards (scene_type, title, summary, personal, source_kind, ...)",
    (...)
)
# recall_seconds, next_recall, recall_interval, difficulty, recall_count, last_recalled 全部丢弃
```

**修改后：**
```python
# memory.py — 完整保留全部字段
INSERT INTO cards (scene_type, title, summary, personal, source_kind, ...,
    recall_seconds, next_recall, recall_interval, difficulty, recall_count, last_recalled)
VALUES (...)
```

**为什么这样改：** 号称"备份"的功能不保真，是信任陷阱。用户换设备后回忆进度清零，等于"备份"骗了用户。

**收益：** 导出再导入后回忆进度完整保留；配合智能同步（按标题+日期去重、回忆进度取较高值）实现真正的跨设备迁移。

#### 3. AI 联结全量覆盖导致好结果丢失

**问题：** `save_ai_connections` 每次发现都用 `DELETE FROM ai_connections` 清空再写入，用户认可的结果在下一次发现时消失。

**修改前：**
```python
# memory.py — 每次全量覆盖
def save_ai_connections(pairs):
    conn.execute("DELETE FROM ai_connections")
    for p in pairs:
        conn.execute("INSERT INTO ai_connections ...")
```

**修改后：**
```python
# memory.py — 增量合并：只添加新对，已有不覆盖
def save_ai_connections(pairs):
    existing = set()  # 先查已有 (min,max) 对
    for p in pairs:
        key = (min(a, b), max(a, b))
        if key not in existing:
            conn.execute("INSERT INTO ai_connections ...")
            existing.add(key)
    return added  # 返回新增数
```

**为什么这样改：** AI 每次结果可能不同，全量覆盖意味着用户无法积累认可的联结。改为增量后，用户可以反复发现、逐步积累，新卡片也能在已有基础上扩展。

**收益：** 用户可以反复发现而不丢失旧联结；添加新卡片后再次发现只扩展不覆盖。

### P1（健壮性提升）

#### 4. 联结可锁定 + 清除只删未锁定

**问题：** 线太多想清除，但清除会把认可的也一起删掉，用户没有"保留好的"选项。

**修改前：**
```python
# memory.py — 清除 = 全删
def clear_ai_connections():
    conn.execute("DELETE FROM ai_connections")
```

**修改后：**
```python
# memory.py — 新增 locked 字段，清除只删未锁定
"ALTER TABLE ai_connections ADD COLUMN locked INTEGER DEFAULT 0"

def clear_ai_connections():
    conn.execute("DELETE FROM ai_connections WHERE locked = 0")

def toggle_connection_lock(card_a, card_b):
    # 双向查询 + 切换 locked 状态
```

**为什么这样改：** 联结管理需要"选择性保留"。锁定后变白色（区别于青色未锁定和金色标签线），清除时自动跳过。

**收益：** 用户可以放心清除杂乱线，只留下认可的；视觉上三色分明（金=标签、青=AI未锁、白=AI已锁）。

#### 5. 月度叙事生成失败（选错月份）

**问题：** 前端写死 `new Date()` 取当前月（8月），但用户卡片都是 7 月的，后端找不到卡片返回 400，前端没处理就显示"占位"。

**修改前：**
```js
// app_plus.js — 写死当前月
var d = new Date(), ms = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
```

**修改后：**
```js
// app_plus.js — 跟随时间线选中月份
var ny = td.getFullYear(), nm = td.getMonth();
var ms = ny + '-' + String(nm + 1).padStart(2, '0');
```

同时后端增加自动回退：
```python
# main.py — 选中月份无卡片时回退到最近有卡片的月份
if not all_cards:
    best_month = max(c["source_date"][:7] for c in recent if c.get("source_date"))
    all_cards = [c for c in recent if c["source_date"][:7] == best_month]
```

**为什么这样改：** "生成本月回顾"应该回顾用户有记忆的月，而不是日历上的当前月。

**收益：** 点击按钮后真正生成 AI 叙事（已验证：275 字正文、`ai_used: True`），不再出现"占位"。

#### 6. OpenAI 视觉模型名不可配置

**问题：** OpenAI 视觉路径硬编码 `model: "gpt-4o"`，无法适配其他兼容端点。

**修改前：**
```python
body = {"model": "gpt-4o", ...}
```

**修改后：**
```python
body = {"model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o"), ...}
```

**为什么这样改：** 与文本模型路径（已有 `OPENAI_TEXT_MODEL`）保持一致，用户可按需配置不同视觉模型。

**收益：** 视觉模型可通过环境变量灵活配置。

#### 7. 3D 图谱线条悬停选中不准

**问题：** Three.js raycaster 按三维空间距离选线，离镜头近但屏幕上远的线会抢过视觉上离鼠标更近的线——鼠标靠近 A 线却选中了更远的 B 线。

**修改前：**
```js
// graph3d.js — 3D 射线检测
ray.params.Line.threshold = 6;
var lHits = ray.intersectObjects(tagLines, false);
var nl = lHits.length > 0 ? lHits[0].object : null;
```

**修改后：**
```js
// graph3d.js — 屏幕空间像素距离
function pickLine(arr) {
    var mpx = ((mx + 1) / 2) * rc.width;   // 鼠标屏幕 x
    var mpy = ((1 - my) / 2) * rc.height;  // 鼠标屏幕 y
    for (var i = 0; i < arr.length; i++) {
        // 端点投影到屏幕坐标，计算点到线段的像素距离
        var dist = pointToSegment(mpx, mpy, ...);
        if (dist < 15) { best = L; }  // 15px 阈值
    }
}
```

**为什么这样改：** 用户看到的是 2D 投影，应该按屏幕距离而非 3D 距离判断"离哪根线最近"。

**收益：** 鼠标靠近哪根线就选中哪根，所见即所选。

### P2（体验优化）

#### 8. 回退模式伪装成 AI 结论

**问题：** 无 Key 时前端照常显示"AI 筛选出 N 条"，但实际是模板生成的占位卡片，用户被误导。

**修改前：**
```js
html += '<div>AI 筛选出 ' + drafts.length + ' 条值得留存的内容</div>';
```

**修改后：**
```js
var label = data.ai_used ? 'AI 筛选出' : '未接入 AI，以下为原始素材占位卡片';
html += '<div>' + label + ' ' + drafts.length + ' 条</div>';
```

**为什么这样改：** "诚实表达人与 AI 关系"是产品的核心主张。回退时不诚实，等于产品自己打脸。

**收益：** 用户清楚知道当前是否为真实 AI 分析；与产品理念一致。

#### 9. 个人归因缺少引导

**问题：** 种子卡都填好了 `personal` 字段，但新卡片用户直接"确认保存"就跳过了，产品灵魂字段形同虚设。

**修改后：** 卡片上 `personal` 为空时标注"待你赋予意义"，提示用户补填。

**为什么这样改：** "个人归因"是 AI 无法替代的部分，也是产品区分于纯工具的核心。缺少引导等于放弃这个差异点。

**收益：** 用户更可能填写个人归因，产品主张真正落地。

#### 10. uvicorn 自动重载无效

**问题：** 加了 `reload=True` 但传的是 app 对象而非 import string，uvicorn 警告无法重载，改代码后必须手动重启。

**修改前：**
```python
uvicorn.run(app, host="0.0.0.0", port=8001, reload=True)
```

**修改后：**
```python
uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True, reload_dirs=["."])
```

**为什么这样改：** uvicorn 的 reload 模式要求传入字符串路径（"module:app"），传对象无法监控文件变化。

**收益：** 改 Python 代码后服务器自动重启，开发效率提升。

---

## v0.7 -- 3D 记忆星图 + 工具栏优化（2026-07-31）

**定位：** 记忆图谱从 2D 力导向布局升级为 Three.js 3D 星空，工具栏视觉打磨。

### P1（健壮性提升）

#### 1. panel-calendar 缺少闭合 div 导致面板切换失效

**问题：** `panel-calendar` 标签没有闭合，导致回忆挑战和记忆星图两个面板被嵌套进时间线面板内，切换 tab 时无法显示。

**修改前：**
```html
<!-- index.html — 缺少 </div> -->
<div class="tab-panel" id="panel-calendar">
    ...
    <div class="timeline-cards" id="timelineCards"></div>
<!-- 直接开始下一个 panel，没有闭合 -->
<div class="tab-panel" id="panel-recall">
```

**修改后：**
```html
<div class="tab-panel" id="panel-calendar">
    ...
    <div class="timeline-cards" id="timelineCards"></div>
</div>  <!-- 补上闭合 -->
<div class="tab-panel" id="panel-recall">
```

**为什么这样改：** HTML 标签不闭合会导致后续 DOM 结构全部错位，面板切换逻辑依赖正确的面板嵌套关系。

**收益：** 回忆挑战、记忆星图、时间线三个面板各自独立，切换正常。

#### 2. 按钮 flex-basis:0% 导致文字竖排

**问题：** `flex:0` 这个简写等于 `flex-basis:0%`，按钮试图以零宽度开始布局，中文字逐字换行变成竖排。

**修改前：**
```html
<button style="flex:0;padding:10px 24px;width:auto">导出</button>
```

**修改后：**
```html
<button style="flex:0 0 auto;padding:10px 24px;width:auto">导出</button>
```

**为什么这样改：** `flex:0` 展开为 `flex-grow:0; flex-shrink:0; flex-basis:0%`。`flex-basis:0%` 意味着初始宽度为零，内容被挤到逐字换行。`0 0 auto` 让基准宽度由内容决定。

**收益：** 导出、导入、标签管理等按钮文字正常横排。

### P2（体验优化）

#### 3. 星图白底修复

**问题：** WebGLRenderer 默认透明背景，深空效果失效。

**修改前：**
```js
var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
```

**修改后：**
```js
var renderer = new THREE.WebGLRenderer({ antialias: true });
scene.background = new THREE.Color(0x05050f);
```

**为什么这样改：** `alpha:true` 让 canvas 透明，后面的 CSS 背景色透出，破坏了星空效果。

**收益：** 星图呈现深空黑底，恒星和星云的发光效果正常。

---

## v0.6 -- 从演示走向日常可用（2026-07-31）

**定位：** 修复手机端现场采集与局域网访问的硬伤，补上断网采集、到期提醒、多档案、记忆图谱与真实账单。

**审查/修改背景：** 真机体验发现 0.0.0.0 无法访问、部分浏览器录音无响应、桌面拍照/录像与上传行为混淆。

### P0（关键缺陷）

#### 1. 手机端录音/拍照/录像与 HTTPS 局域网访问

**问题：** 手机在部分浏览器点录音没有可用方式，0.0.0.0 地址手机/电脑都打不开。

**修改前：**
```python
# main.py — 仅监听 0.0.0.0 的 HTTP，非安全上下文
uvicorn.run(app, host="0.0.0.0", port=8001)
```

**修改后：**
```python
# main.py — 自动生成含局域网 IP 的 SAN 自签证书
cert = _ensure_cert(ip)
uvicorn.run("main:app", host="0.0.0.0", port=8001,
            ssl_certfile=cert[0], ssl_keyfile=cert[1], reload=True)
```

**为什么这样改：** 录音/摄像头 API 要求安全上下文，只有 HTTPS（或 localhost）才可用；自签证书自动包含 127.0.0.1 与局域网 IP。

**收益：** 手机浏览器内录音、拍照、录像真正可用；电脑与手机使用统一 https 地址。

#### 2. 断网现场采集暂存与自动同步

**问题：** 现场网络不好时，点击生成直接失败，采集内容可能丢失。

**修改前：**
```js
} catch (e) {
  alert("分析失败：" + e.message);
}
```

**修改后：**
```js
} catch (e) {
  if (!navigator.onLine || e instanceof TypeError) {
    await queueOfflineAnalyze({...});
    renderOfflineStatus("网络不可用，本次采集已暂存，联网后自动同步");
  } else {
    alert("分析失败：" + e.message);
  }
}
```

**为什么这样改：** 把 File/Blob 与备注写入 IndexedDB，监听 online 事件自动重试。

**收益：** 弱网/断网现场也能随手拍随手录；联网后自动同步，不丢素材。

### P1（健壮性提升）

#### 3. 到期回忆提醒与回忆投入计时

**问题：** 回忆只能靠用户主动打开页面，账单无法体现真实复习投入。

**修改后：**
```js
const secs = Math.max(1, Math.round((Date.now() - recallStartTs) / 1000));
await api("/api/recall/" + card.id + "/attempt", { body: JSON.stringify({ difficulty, seconds: secs }) });
```

**为什么这样改：** 到期提醒需要浏览器通知授权；回忆时长应随难度一起入库，账单才能诚实反映投入。

**收益：** 到期卡片收到通知提醒；复习时长进入认知账单。

#### 4. 多档案本地隔离

**问题：** 单机单数据库，共用一台电脑时数据互相混杂。

**修改前：**
```python
DB_PATH = Path(__file__).parent / "data" / "memory.db"
```

**修改后：**
```python
def _db_path():
    name = current_profile()  # 从请求上下文获取
    if name == "default":
        return DB_DIR / "memory.db"
    return DB_DIR / ("memory_" + name + ".db")
```

**为什么这样改：** 用 contextvars 隔离请求上下文，前端切换档案即切换数据库文件。

**收益：** 同一台电脑可多人各自管理记忆库。

#### 5. 认知账单：真实时间与估算对照

**问题：** "节省时间"是固定系数估算，用户觉得数据是编出来的。

**修改前：**
```python
minutes = len(materials) * scenario["minutes_per_material"]
```

**修改后：**
```python
t0 = time.monotonic()
cards_data = llm.analyze_materials(materials, scene_type, personalization)
ai_seconds = max(0.0, time.monotonic() - t0)
memory.record_ledger(..., ai_seconds=ai_seconds)
```

**为什么这样改：** AI 处理时长按真实调用计时，估算仅保留为对照参考。

**收益：** 账单从"估算值"变成"真实测量 + 估算对照"。

---

## v0.5 -- 文件夹管理与标签编辑（2026-07-26）

**定位：** 新增文件夹分组视图、卡片详情页删除按钮、标签动态编辑，修复若干交互 bug。

### P0（关键缺陷）

#### 1. 卡片详情页 body.innerHTML 未赋值导致页面卡死

**问题：** `openCardModal` 函数缺少 `body.innerHTML = html`，打开详情后弹窗空白且无法关闭。

**修改前：**
```js
function openCardModal(card) {
    var html = '<div class="modal-body">...';
    // 缺少 body.innerHTML = html
}
```

**修改后：**
```js
function openCardModal(card) {
    var html = '<div class="modal-body">...';
    body.innerHTML = html;  // 补上
}
```

**为什么这样改：** HTML 构建了但没渲染到 DOM，弹窗内容为空。

**收益：** 卡片详情正常显示。

#### 2. 编辑按钮传 id 而非 card 对象

**问题：** 编辑按钮 `onclick="editCard(card.id)"` 只传了 id，但 `editCard` 函数需要完整 card 对象来填充表单。

**修改前：**
```js
'<button onclick="editCard(' + card.id + ')">编辑</button>'
```

**修改后：**
```js
'<button onclick="editCard(' + JSON.stringify(card) + ')">编辑</button>'
```

**为什么这样改：** 编辑表单需要 title/summary/tags 等字段，只传 id 无法回填。

**收益：** 点击编辑后表单正确回填已有内容。

### P1（健壮性提升）

#### 3. memory.py 缺少 list_batches 函数

**问题：** 前端调用 `/api/batches` 但 `memory.py` 缺少 `list_batches()` 函数，文件夹视图直接报错。

**修改后：**
```python
def list_batches():
    conn = get_db()
    rows = conn.execute(
        """SELECT batch_id, scene_type, source_date,
                  COUNT(*) as card_count, MIN(created_at) as created_at
           FROM cards WHERE batch_id != '' AND status != 'deleted'
           GROUP BY batch_id ORDER BY created_at DESC"""
    ).fetchall()
```

**为什么这样改：** 文件夹分组依赖按 batch_id 聚合查询，缺少此函数 API 返回 500。

**收益：** 文件夹视图正常加载。

#### 4. batch API 路由定义在 app 定义之后

**问题：** `@app.get("/api/batches")` 写在 `app` 变量定义之前，FastAPI 注册路由时报 NameError。

**修改前：**
```python
@app.get("/api/batches")  # app 还没定义
def api_batches(): ...
app = FastAPI()  # 定义在后面
```

**修改后：**
```python
app = FastAPI()  # 先定义
@app.get("/api/batches")  # 再注册路由
def api_batches(): ...
```

**为什么这样改：** Python 从上到下执行，装饰器在 `app` 未定义时无法工作。

**收益：** 启动不再报 NameError。

### P2（体验优化）

#### 5. 删除按钮字符串拼接闭包陷阱

**问题：** 删除按钮的 `onclick` 字符串在 HTML 模板字符串内被错误拼接，点击时执行的是 `slice()` 的返回值而非 `deleteCard` 函数。

**为什么这样改：** JS 构建 HTML 字符串时，onclick 属性内的变量引用容易被困在外层字符串里，导致实际执行的是错误表达式。

**收益：** 删除按钮点击后正确调用 `deleteCard`。

---

## v0.4 -- 标签和图片动态编辑（2026-07-26）

**定位：** 标签可在卡片详情页直接编辑，图片上传时保留中文文件名并加时间戳去重。

### P2（体验优化）

#### 1. 图片文件名 URL 编码丢失中文

**问题：** 浏览器上传中文文件名时可能 URL 编码，后端保存后数据库里存的是编码后的乱码路径，前端无法正确加载图片。

**修改前：**
```python
filename = file.filename  # 可能是 URL 编码的 %E4%B8%AD...
```

**修改后：**
```python
from urllib.parse import unquote
filename = unquote(file.filename)  # 解码回中文
# 加时间戳防重名
filename = str(int(time.time())) + "_" + filename
```

**为什么这样改：** 中文文件名在不同浏览器/操作系统间的编码行为不一致，统一解码可保证一致性。

**收益：** 中文文件名的图片正确保存和加载；时间戳防止同名文件覆盖。

#### 2. 标签动态编辑

**问题：** 标签只能在生成时由 AI 设置，之后无法修改。

**修改后：** 卡片详情页新增标签编辑入口，支持添加/删除/重命名。

**收益：** 用户可以事后修正 AI 生成的标签。

---

## v0.3 -- 产品报告与体验打磨（2026-07-26）

**定位：** 补充完整产品报告（主题解读、架构、功能详解），修复 hero 间距、回忆开关、说明区紧凑化等 UI 问题。

### P2（体验优化）

#### 1. 回忆挑战从默认开启改为用户手动开关

**问题：** 所有卡片默认进入间隔重复系统，但不是每张卡片都需要复习，用户被过多到期卡片淹没。

**修改前：** 卡片创建时 `recall_enabled = 1`（默认开启）

**修改后：** 卡片创建时 `recall_enabled = 0`（默认关闭），用户在卡片上手动开启。

**为什么这样改：** 基于用户自主权——只有在真正想记住某条内容时才进入复习，确保复习行为的动机质量。

**收益：** 用户不被无关卡片的复习提醒打扰。

#### 2. 绑定地址从 0.0.0.0:8000 改为 127.0.0.1:8001

**问题：** 0.0.0.0 地址部分浏览器/防火墙拒绝访问，端口 8000 可能被占用。

**修改前：**
```python
uvicorn.run(app, host="0.0.0.0", port=8000)
```

**修改后：**
```python
uvicorn.run(app, host="127.0.0.1", port=8001)
```

**为什么这样改：** 初版先保证本机可访问，端口 8001 避免常见冲突。（v0.6 又改回 0.0.0.0 配合 HTTPS 支持手机访问。）

**收益：** 本地开发阶段稳定访问。

---

## v0.2 -- 产品报告与文档完善（2026-07-26）

**定位：** 添加完整产品报告，涵盖主题解读、系统架构、功能详解、人与 AI 关系思考等章节；接入 GitHub 仓库地址。

### P3（打磨）

- README 扩充为完整产品报告（九大章节）
- 接入真实 GitHub 仓库链接
- hero 区间距优化、说明区紧凑化

---

## v0.1 -- 项目初始化（2026-07-26）

**定位：** 在场 — AI 记忆工坊初始版本，核心功能闭环。

**核心能力：**
- 采集提炼：场景选择 + 素材上传 + AI 分析（通义千问 Vision / OpenAI / 预生成回退）
- 记忆库：卡片 CRUD + 场景筛选
- 认知账单：素材数、卡片数、估算节省时间
- 回忆挑战：间隔重复算法（1/3/7/14/30 天）
- PWA 基础壳（manifest + service worker）
- 种子数据：沪杭实践真实参访记录（7 站 14 张卡片）
