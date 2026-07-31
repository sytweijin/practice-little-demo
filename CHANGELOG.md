# CHANGELOG

本文件记录“在场 — AI 记忆工坊”的重要变更。格式遵循团队约定：每条记录包含问题 / 修改前 / 修改后 / 为什么这样改 / 收益，按优先级分组。

## v0.6 -- 从演示走向日常可用（2026-07-31）

**定位：** 修复手机端现场采集与局域网访问的硬伤，补上断网采集、到期提醒、多档案、记忆图谱与真实账单，让项目从参赛演示升级为可日常使用的小工具。

**审查/修改背景：** 真机体验发现 0.0.0.0 无法访问、部分浏览器录音无响应、桌面拍照/录像与上传行为混淆；评审同时提出手机接口、断网现场采集、真实账单、推送提醒、记忆联结等提升点。

### 修复（2026-07-31 追加）

- 回忆挑战 / 记忆图谱点击无响应：panel-calendar 缺少闭合 div，导致两个面板嵌套进时间线面板内；补上闭合标签，恢复独立面板切换。
- 工具栏多余空白：demo-toolbar 使用 space-between 把安装按钮推到最右；改为 flex-start，让按钮紧邻档案区。
- PWA 缓存升级到 presence-v3，避免旧静态资源缓存干扰功能更新。
### v0.7 -- 3D 记忆星图 + 工具栏优化（2026-07-31）

**记忆图谱升级为 3D 星空：**
- 每种场景（企业参访、展览、会议等）自动形成一个星团，卡片是星团中的发光星点
- 深空背景：三层恒星场（蓝白/白/黄白/橙红光谱）+ 五团星云 + 雾化景深，卡片星点有双层光晕呼吸脉动
- 支持拖拽旋转、滚轮缩放、点击星点查看详情、悬停显示毛玻璃 tooltip
- 共享标签的卡片之间用金色光线连接，悬停光线显示标签名
- 关键词搜索过滤：输入后匹配星点高亮放大，其余暗淡，快速定位目标记忆
- 自动缓慢旋转，用户交互后停止；加载失败时自动回退到 2D 图谱

**工具栏优化：**
- 去掉嵌套的 profile-box 包裹层，档案选择/新建/安装按钮改为同一行平铺
- 修复 btn-primary 的 flex-basis:0% 导致按钮文字竖排的问题（改为 flex: 0 0 auto）
- 下拉框精致化：自定义箭头、hover/focus 发光、option 样式

**其他修复：**
- 星图白底修复（渲染器去掉 alpha:true，显式设置深空背景色）
- 星团标注文字增强可见度（透明度 0.12 → 0.42，加暗色描边）
- 核心主张图标精致化（加圆角徽章底色）
- panel-calendar 缺少闭合标签导致回忆挑战/记忆星图面板无法切换（已修复）
### P0（关键缺陷）

#### 1. 手机端录音/拍照/录像与 HTTPS 局域网访问

**问题：** 手机在部分浏览器点录音没有可用方式，0.0.0.0 地址手机/电脑都打不开，且电脑端拍照录像按钮与上传文件行为混淆。

**修改前：**
```python
# main.py 仅监听 0.0.0.0 的 HTTP，手机在局域网会被浏览器判为非安全上下文
uvicorn.run(app, host="0.0.0.0", port=8001)
```
```js
// app.js 录音依赖 getUserMedia，在非 HTTPS 局域网直接被跳过
if (!canRecord) { fb.click(); return; }
```

**修改后：**
```python
# main.py 启动时自动生成/续期含局域网 IP 的 SAN 自签证书，以 HTTPS 提供服务
cert = _ensure_cert(ip)
uvicorn.run(app, host="0.0.0.0", port=8001,
            ssl_certfile=cert[0], ssl_keyfile=cert[1])
```
```js
// app.js 桌面非触屏走浏览器内摄像头拍照/录像；手机继续走原生相机
camBtn.onclick = () => openCameraCapture("photo", camInput);
vidBtn.onclick = () => openCameraCapture("video", vidInput);
```

**为什么这样改：** 录音/摄像头 API 要求安全上下文，只有 HTTPS（或 localhost）才可用；自签证书自动包含 127.0.0.1 与局域网 IP，使手机能直接访问。

**收益：** 手机浏览器内录音、拍照、录像真正可用；电脑与手机使用统一 https 地址，不再需要额外配置。

### P1（健壮性提升）

#### 2. 断网现场采集暂存与自动同步

**问题：** 现场网络不好时，点击生成会直接失败，采集内容可能丢失。

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
    await queueOfflineAnalyze({ scene_type: selectedScenario, personalization, notes, files: selectedFiles.slice() });
    renderOfflineStatus("网络不可用，本次采集已暂存，联网后自动同步");
  } else {
    alert("分析失败：" + e.message);
  }
}
```

**为什么这样改：** 把 File/Blob 与备注写入 IndexedDB，监听 online 事件自动重试，采集不再依赖网络瞬时可用。

**收益：** 弱网/断网现场也能随手拍随手录；联网后一键同步，不丢素材。

#### 3. 到期回忆提醒与回忆投入计时

**问题：** 回忆只能靠用户主动打开页面，且账单无法体现真实复习投入。

**修改前：**
```js
b.onclick = async () => {
  await api("/api/recall/" + card.id + "/attempt", { ... });
};
```

**修改后：**
```js
b.onclick = async () => {
  const secs = Math.max(1, Math.round((Date.now() - recallStartTs) / 1000));
  await api("/api/recall/" + card.id + "/attempt", { ..., body: JSON.stringify({ difficulty, seconds: secs }) });
};
```

**为什么这样改：** 到期提醒需要浏览器通知授权，且回忆时长应随难度一起入库，才能让账单诚实反映用户投入。

**收益：** 到期卡片会收到通知提醒；复习时长进入认知账单，形成可解释的真实数据。

#### 4. 多档案本地隔离

**问题：** 单机单数据库，家人或同事共用一台电脑时数据互相混杂。

**修改前：**
```python
DB_PATH = Path(__file__).parent / "data" / "memory.db"
```

**修改后：**
```python
def _db_path():
    name = current_profile()
    if name == "default":
        return DB_DIR / "memory.db"
    return DB_DIR / ("memory_" + name + ".db")
```
```python
class ProfileMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        profile = request.headers.get("X-Presence-Profile", "") or request.cookies.get("presence_profile", "")
        if profile:
            memory.set_profile(profile)
```

**为什么这样改：** 多档案采用“请求上下文 + 独立 SQLite 文件”的最简方案，前端切换档案即切换数据库，数据完全隔离。

**收益：** 同一台电脑可多人各自管理记忆库；配合 JSON 导出/导入实现最简跨设备迁移。

### P2（体验优化）

#### 5. 认知账单：真实时间与估算对照

**问题：** “节省时间”是固定系数估算，用户会觉得数据是编出来的。

**修改前：**
```python
minutes = len(materials) * scenario["minutes_per_material"]
memory.record_ledger(scene_type, len(materials), minutes, len(saved))
```

**修改后：**
```python
t0 = time.monotonic()
cards_data = llm.analyze_materials(materials, scene_type, personalization)
ai_seconds = max(0.0, time.monotonic() - t0)
memory.record_ledger(..., ai_seconds=ai_seconds)
```

**为什么这样改：** AI 处理时长按真实调用计时，复习时长按用户操作计时，估算仅保留为“对照参考”。

**收益：** 账单从“估算值”变成“真实测量 + 估算对照”，重建数据可信度。

#### 6. 记忆图谱

**问题：** 记忆之间的联结停留在文案里，没有可视化入口。

**修改前：** 仅卡片详情内按共享标签列出“相关记忆”。

**修改后：**
```python
@app.get("/api/graph")
def api_graph(limit: int = 200):
    return memory.graph_data(limit)
```
```js
// app.js 新增图谱 tab：卡片-标签二部图 + 简单力导向布局
svg += '<rect ... stroke="' + color + '" .../>';
svg += '<text ...>' + esc(truncateLabel(n.label, 14)) + "</text>";
```

**为什么这样改：** 用标签作为联结边，把孤立卡片变成可点击浏览的记忆网络。

**收益：** 跨场景联结直观可见，点击卡片即可回到详情，强化“AI 守联结”的产品主张。

#### 7. PWA 安装与离线壳

**问题：** 手机每次都要开浏览器输网址，依赖网络才能打开。

**修改前：**
```json
{ "start_url": "/", "display": "standalone" }
```

**修改后：**
```json
{ "id": "/", "scope": "/", "display_override": ["standalone", "minimal-ui"] }
```
```js
window.addEventListener("beforeinstallprompt", function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById("installBtn").style.display = "inline-flex";
});
```

**为什么这样改：** manifest 补全安装元数据，Service Worker 缓存应用壳，浏览器提供安装入口。

**收益：** 桌面/手机可安装为独立应用；断网仍能打开界面并暂存采集。

### P3（打磨）

#### 8. README 与数据模型同步

**问题：** README 的“无用户系统/无移动端优化”描述已与实现不符，数据模型缺新字段。

**修改前：**
```
- 无用户系统：当前为单用户设计，不支持多用户隔离
- 无移动端优化：尽管响应式设计适配了手机屏幕，但上传等操作在移动端体验不佳
```

**修改后：**
```
- 同步仍是手动边界：多档案为本地优先，跨设备同步依赖 JSON 导出/导入
- 音频转写（配置式）：无 API Key 时录音作为素材随卡片归档；配置 DashScope 或 OpenAI Key 后自动转写，转写文本参与卡片筛选与总结生成
```

**为什么这样改：** 文档需反映当前真实能力与边界，避免“承诺-实现”落差。

**收益：** README 与代码行为一致，评委和用户看到的是真实可用的版本。
