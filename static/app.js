// ===== 在场 — Frontend Logic =====
const API = "";
let scenarios = [];
let cards = [];
let selectedScenario = "museum";
let selectedFiles = [];
let currentFilter = "folders";
let recallQueue = [];
let recallIndex = 0;
let recallStartTs = 0;
var batches = [];
var batchMode = false;
var selectedIds = {};

// ---- Init ----
document.addEventListener("DOMContentLoaded", () => {
  // wire up controls first so they never get blocked by a data-load error
  setupTabs();
  setupUpload();
  setupAnalyze();
  setupBatch();
  setupProfile();
  setupPWA();
  setupGraph();
  setupNotifications();
  initOfflineQueue();
  handleSharedContent();
  // data loads are independent; one failure must not break the others
  loadScenarios().catch(e => console.warn("scenarios", e));
  loadCards().catch(e => console.warn("cards", e));
  loadLedger().catch(e => console.warn("ledger", e));
  loadRecall().catch(e => console.warn("recall", e));
});

// ---- API helpers ----
const profileName = () => localStorage.getItem("presenceProfile") || "default";
async function api(path, opts = {}, skipJson) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  opts.headers["X-Presence-Profile"] = profileName();
  const r = await fetch(API + path, opts);
  if (!r.ok) throw new Error(path + " " + r.status);
  if (skipJson) return r;
  return r.json();
}

// ---- Scenarios ----
async function loadScenarios() {
  const data = await api("/api/scenarios");
  scenarios = data.scenarios;
  const grid = document.getElementById("scenarioGrid");
  grid.innerHTML = scenarios.map(s =>
    '<div class="scenario-chip' + (s.key === selectedScenario ? " selected" : "") + '" data-key="' + s.key + '">' + s.name + "</div>"
  ).join("");
  grid.querySelectorAll(".scenario-chip").forEach(el => {
    el.onclick = () => {
      selectedScenario = el.dataset.key;
      grid.querySelectorAll(".scenario-chip").forEach(c => c.classList.remove("selected"));
      el.classList.add("selected");
    };
  });
}

// ---- Tabs ----
function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "graph") loadGraph();
    };
  });
}

// Render <img> or <video> depending on file extension
function isVideoUrl(url) {
  if (!url) return false;
  return /\.(mp4|mov|webm|avi|mkv|m4v|3gp)(\?|$)/i.test(url);
}
function mediaTag(url, cls, style) {
  if (!url) return "";
  cls = cls || "";
  style = style || "";
  if (isVideoUrl(url)) return '<video ' + cls + ' ' + style + ' src="' + url + '" controls playsinline></video>';
  return '<img ' + cls + ' ' + style + ' src="' + url + '" alt="">';
}

// ---- In-browser audio recorder (MediaRecorder) ----
// Mobile file inputs can't reliably trigger a pure audio recorder,
// so we record directly via getUserMedia + MediaRecorder.
var rec = null, recChunks = [], recStream = null, recTimer = null, recSecs = 0;
var camStream = null, camRec = null, camChunks = [], camTimer = null, camSecs = 0, camMode = "photo";
function _pickRecMime() {
  var opts = ['audio/webm', 'audio/mp4', 'audio/ogg'];
  for (var i = 0; i < opts.length; i++) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch(e){}
  }
  return '';
}
function startRecording() {
  // getUserMedia / MediaRecorder require a secure context (HTTPS or localhost).
  // Accessing http://192.168.x.x from a phone is NOT secure, so we skip the
  // mic API entirely and fall back to picking an existing audio file.
  // This also avoids a failure that can freeze all buttons on some phones.
  var canRecord = window.isSecureContext && navigator.mediaDevices &&
                  navigator.mediaDevices.getUserMedia && window.MediaRecorder;
  if (!canRecord) {
    var fb = document.getElementById('audioFallbackInput');
    if (fb) { fb.click(); }
    else { alert('当前环境（HTTP）不支持浏览器内录音，请用上传音频文件的方式。'); }
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    recStream = stream;
    var mime = _pickRecMime();
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recChunks = [];
    rec.ondataavailable = function(e) { if (e.data.size > 0) recChunks.push(e.data); };
    rec.onstop = function() {
      var type = rec.mimeType || 'audio/webm';
      var ext = type.indexOf('mp4') >= 0 ? 'm4a' : (type.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
      var blob = new Blob(recChunks, { type: type });
      var file = new File([blob], 'recording_' + Date.now() + '.' + ext, { type: type });
      addFiles([file]);
      recStream.getTracks().forEach(function(t) { t.stop(); });
      recStream = null;
    };
    rec.start();
    recSecs = 0;
    document.getElementById('recorderTimer').textContent = '00:00';
    document.getElementById('recorderOverlay').classList.add('show');
    recTimer = setInterval(function() {
      recSecs++;
      var m = String(Math.floor(recSecs / 60)).padStart(2, '0');
      var sec = String(recSecs % 60).padStart(2, '0');
      document.getElementById('recorderTimer').textContent = m + ':' + sec;
    }, 1000);
  }).catch(function(err) {
    // Make sure we never leave a dangling overlay that blocks the whole UI
    var ov = document.getElementById('recorderOverlay');
    if (ov) ov.classList.remove('show');
    if (recStream) { recStream.getTracks().forEach(function(t){ t.stop(); }); recStream = null; }
    alert('无法访问麦克风：' + (err.message || err.name) + '\n你可以改用上传音频文件的方式录音。');
  });
}
function stopRecording() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  if (rec && rec.state !== 'inactive') rec.stop();
  document.getElementById('recorderOverlay').classList.remove('show');
}
// init stop button
var _recStopBtn = document.getElementById('recorderStop');
if (_recStopBtn) _recStopBtn.onclick = stopRecording;

var _camCaptureBtn = document.getElementById('cameraCaptureBtn');
if (_camCaptureBtn) _camCaptureBtn.onclick = function() {
  if (camMode === "photo") capturePhotoFromStream(); else toggleDesktopVideo();
};
var _camCancelBtn = document.getElementById('cameraCancelBtn');
if (_camCancelBtn) _camCancelBtn.onclick = closeDesktopCamera;


// ---- In-browser desktop camera (photo / video) ----
function isTouchPrimary() {
  return window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}

function openCameraCapture(mode, fallbackInput) {
  var secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!secure || isTouchPrimary()) {
    fallbackInput.click();
    return;
  }
  startDesktopCamera(mode, fallbackInput);
}

function _pickVideoMime() {
  var opts = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (var i = 0; i < opts.length; i++) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch(e){}
  }
  return "";
}

function startDesktopCamera(mode, fallbackInput) {
  if (mode === "video" && !window.MediaRecorder) {
    fallbackInput.click();
    return;
  }
  camMode = mode;
  var overlay = document.getElementById("cameraOverlay");
  var preview = document.getElementById("cameraPreview");
  var status = document.getElementById("cameraStatus");
  var timer = document.getElementById("cameraTimer");
  var captureBtn = document.getElementById("cameraCaptureBtn");
  overlay.classList.add("show");
  status.textContent = "正在打开摄像头";
  timer.textContent = "00:00";
  timer.style.visibility = mode === "video" ? "visible" : "hidden";
  captureBtn.textContent = mode === "video" ? "开始录像" : "拍摄";
  navigator.mediaDevices.getUserMedia({ video: true }).then(function(stream) {
    camStream = stream;
    preview.srcObject = stream;
    preview.play().catch(function(){});
    status.textContent = mode === "video" ? "预览中，点击开始录像" : "预览中，点击拍摄";
  }).catch(function(err) {
    overlay.classList.remove("show");
    alert("无法打开摄像头：" + (err.message || err.name) + "，将改为选择文件。");
    fallbackInput.click();
  });
}

function capturePhotoFromStream() {
  var video = document.getElementById("cameraPreview");
  if (!video.videoWidth) { alert("摄像头还没准备好，请稍后再试。"); return; }
  var canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(function(blob) {
    if (!blob) { alert("拍照失败，请重试。"); return; }
    addFiles([new File([blob], "camera_" + Date.now() + ".jpg", { type: "image/jpeg" })]);
    closeDesktopCamera();
  }, "image/jpeg", 0.92);
}

function toggleDesktopVideo() {
  if (camRec && camRec.state !== "inactive") { closeDesktopCamera(); return; }
  if (!camStream) { alert("摄像头还没准备好，请稍后再试。"); return; }
  var mime = _pickVideoMime();
  var rec;
  try {
    rec = mime ? new MediaRecorder(camStream, { mimeType: mime }) : new MediaRecorder(camStream);
  } catch (err) {
    alert("当前浏览器不支持录像，将改为选择文件。");
    var fi = document.getElementById("videoInput");
    if (fi) fi.click();
    return;
  }
  camRec = rec;
  camChunks = [];
  rec.ondataavailable = function(e) { if (e.data.size > 0) camChunks.push(e.data); };
  rec.onstop = function() {
    var type = rec.mimeType || "video/webm";
    var ext = type.indexOf("mp4") >= 0 ? "mp4" : "webm";
    var blob = new Blob(camChunks, { type: type });
    if (blob.size > 0) {
      addFiles([new File([blob], "video_" + Date.now() + "." + ext, { type: type })]);
    }
    teardownDesktopCamera();
  };
  rec.start();
  camSecs = 0;
  document.getElementById("cameraTimer").textContent = "00:00";
  if (camTimer) clearInterval(camTimer);
  camTimer = setInterval(function() {
    camSecs++;
    var m = String(Math.floor(camSecs / 60)).padStart(2, "0");
    var sec = String(camSecs % 60).padStart(2, "0");
    document.getElementById("cameraTimer").textContent = m + ":" + sec;
  }, 1000);
  document.getElementById("cameraStatus").textContent = "正在录像";
  document.getElementById("cameraCaptureBtn").textContent = "停止";
}

function teardownDesktopCamera() {
  if (camTimer) { clearInterval(camTimer); camTimer = null; }
  if (camStream) {
    camStream.getTracks().forEach(function(t) { t.stop(); });
    camStream = null;
  }
  var preview = document.getElementById("cameraPreview");
  if (preview) preview.srcObject = null;
  var overlay = document.getElementById("cameraOverlay");
  if (overlay) overlay.classList.remove("show");
}

function closeDesktopCamera() {
  if (camRec && camRec.state !== "inactive") {
    var rec = camRec;
    camRec = null;
    try { rec.stop(); } catch(e) { teardownDesktopCamera(); }
    return;
  }
  camRec = null;
  teardownDesktopCamera();
}

// ---- Upload ----
function setupUpload() {
  const zone = document.getElementById("uploadZone");
  const input = document.getElementById("fileInput");
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add("dragover"); };
  zone.ondragleave = () => zone.classList.remove("dragover");
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove("dragover"); addFiles(e.dataTransfer.files); };
  input.onchange = () => addFiles(input.files);
  // Mobile native capture: camera + mic
  const camBtn = document.getElementById("capturePhotoBtn");
  const micBtn = document.getElementById("captureAudioBtn");
  const camInput = document.getElementById("cameraInput");
  const micInput = document.getElementById("micInput");
  const vidBtn = document.getElementById("captureVideoBtn");
  const vidInput = document.getElementById("videoInput");
  if (camBtn && camInput) {
    camBtn.onclick = () => openCameraCapture("photo", camInput);
    camInput.onchange = () => addFiles(camInput.files);
  }
  if (vidBtn && vidInput) {
    vidBtn.onclick = () => openCameraCapture("video", vidInput);
    vidInput.onchange = () => addFiles(vidInput.files);
  }
  if (micBtn) { micBtn.onclick = () => startRecording(); }
  var _afb = document.getElementById('audioFallbackInput');
  if (_afb) { _afb.onchange = () => { if (_afb.files.length) addFiles(_afb.files); _afb.value = ''; }; }
}
// Extract key frames from a video file for AI visual analysis.
// Uses browser-native <video> + canvas, no ffmpeg needed.
async function extractVideoFrames(file, maxFrames) {
  maxFrames = maxFrames || 3;
  return new Promise(function(resolve) {
    var url = URL.createObjectURL(file);
    var video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    var frames = [];
    video.addEventListener("loadedmetadata", function() {
      var duration = video.duration;
      if (!duration || duration < 1) { URL.revokeObjectURL(url); resolve([]); return; }
      // Sample timestamps spread across the video
      var times = [];
      for (var i = 1; i <= maxFrames; i++) {
        times.push(Math.min(duration - 0.2, (duration / (maxFrames + 1)) * i));
      }
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      var idx = 0;
      function seek() {
        if (idx >= times.length) {
          URL.revokeObjectURL(url);
          resolve(frames);
          return;
        }
        video.currentTime = times[idx];
      }
      video.addEventListener("seeked", function() {
        // Downscale to max 720px wide so qwen3.7-plus (a slow reasoning
        // model) can finish inside the timeout. Full-res 1080p/4K frames
        // were the main cause of vision timeouts on video uploads.
        var maxW = 720;
        var scale = Math.min(1, maxW / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function(blob) {
          if (blob) {
            var fname = file.name.replace(/\.[^.]+$/, "") + "_frame" + (idx + 1) + ".jpg";
            frames.push(new File([blob], fname, { type: "image/jpeg" }));
          }
          idx++;
          seek();
        }, "image/jpeg", 0.85);
      });
      seek();
    });
    video.addEventListener("error", function() { URL.revokeObjectURL(url); resolve([]); });
  });
}

function addFiles(fileList) { for (const f of fileList) selectedFiles.push(f); renderFileList(); }
function renderFileList() {
  const list = document.getElementById("fileList");
  list.innerHTML = selectedFiles.map((f, i) =>
    '<div class="file-item"><span>' + getFileIcon(f.type) + "</span><span>" + esc(f.name) +
    '</span><span class="file-remove" data-i="' + i + '">&times;</span></div>'
  ).join("");
  list.querySelectorAll(".file-remove").forEach(el => {
    el.onclick = () => { selectedFiles.splice(parseInt(el.dataset.i), 1); renderFileList(); };
  });
}
function getFileIcon(type) {
  if (type.startsWith("image/")) return "🖼";
  if (type.startsWith("audio/")) return "🎙";
  return "📄";
}

// ---- Analyze ----
function setupAnalyze() { document.getElementById("analyzeBtn").onclick = doAnalyze; }
async function doAnalyze() {
  const btn = document.getElementById("analyzeBtn");
  const notes = document.getElementById("notesInput").value;
  const personalization = document.getElementById("personalizationInput").value;
  if (selectedFiles.length === 0 && !notes.trim()) { alert("请上传至少一个素材，或输入文字备注"); return; }
  btn.disabled = true; btn.textContent = "AI 正在提炼…";
  // Extract key frames from videos for visual AI analysis
  var sendFiles = selectedFiles.slice();
  var allFrames = [];
  var videoFiles = selectedFiles.filter(function(f) { return f.type.startsWith("video/"); });
  if (videoFiles.length) {
    btn.textContent = "提取视频关键帧…";
    for (var vi = 0; vi < videoFiles.length; vi++) {
      var vframes = await extractVideoFrames(videoFiles[vi], 3);
      allFrames = allFrames.concat(vframes);
    }
    btn.textContent = "AI 正在提炼…";
  }
  const fd = new FormData();
  fd.append("scene_type", selectedScenario);
  fd.append("personalization", personalization);
  fd.append("notes", notes);
  fd.append("quick_mode", "false");
  for (const f of sendFiles) fd.append("files", f);
  for (const f of allFrames) fd.append("video_frames", f);
  try {
    const data = await api("/api/analyze", { method: "POST", body: fd });
    renderDraftCards(data.cards, data.minutes_saved, data.ai_seconds, data.ai_used, data.ai_error);
    selectedFiles = []; renderFileList();
    document.getElementById("notesInput").value = "";
    document.getElementById("personalizationInput").value = "";
  } catch (e) {
    if (!navigator.onLine || e instanceof TypeError) {
      await queueOfflineAnalyze({ scene_type: selectedScenario, personalization: personalization, notes: notes, files: selectedFiles.slice() });
      selectedFiles = []; renderFileList();
      document.getElementById("notesInput").value = "";
      document.getElementById("personalizationInput").value = "";
      renderOfflineStatus("网络不可用，本次采集已暂存，联网后自动同步");
    } else {
      alert("分析失败：" + e.message);
    }
  } finally {
    btn.disabled = false; btn.textContent = "生成记忆卡片 →";
  }
}
function renderDraftCards(drafts, minutes, aiSeconds, aiUsed, aiError) {
  const container = document.getElementById("draftCards");
  if (!drafts.length) { container.innerHTML = '<div class="draft-empty">AI 认为本次素材中没有值得长期保存的内容</div>'; return; }
  let aiLabel;
  if (aiUsed === false && aiError) {
    // Key was present but the real call failed — say so explicitly instead of
    // disguising it as "未接入 AI / 配置 API Key".
    aiLabel = "⚠️ AI 调用失败：" + aiError + " · 已降级为占位卡片（请检查 API Key 是否有效、模型名、网络连通性）";
  } else if (aiUsed === false) {
    aiLabel = "⚠️ 未接入 AI，以下为原始素材占位卡片（配置 API Key 后可启用真实筛选）";
  } else {
    aiLabel = "✨ AI 筛选出 " + drafts.length + " 条值得留存的内容 · 预估节省 " + minutes + " 分钟整理时间" + (aiSeconds ? " · AI 实际处理 " + Math.max(1, Math.round(aiSeconds)) + " 秒" : "");
  }
  let html = '<div style="font-size:13px;color:var(--ink-faint);margin-bottom:6px">' + aiLabel + "</div>";
  html += '<div style="font-size:12px;color:var(--ink-faint);margin-bottom:12px;border-left:2px solid var(--line);padding-left:10px"><strong style="color:var(--ink-soft)">AI 的筛选依据：</strong>信息密度 · 独特性 · 长期价值。<span style="color:var(--ink-faint)">个人归因（为什么对你重要）由你补充——AI 不替你判断。</span></div>';
  html += drafts.map(c =>
    '<div class="draft-card" data-id="' + c.id + '">' +
    (c.image_url ? mediaTag(c.image_url, '', 'style="width:100%;max-height:160px;object-fit:cover;border-radius:6px;margin-bottom:8px"') : "") +
    '<div class="dc-title">' + esc(c.title) + "</div>" +
    '<div class="dc-summary">' + esc(c.summary) + "</div>" +
    (c.personal ? '<div class="dc-personal">' + esc(c.personal) + "</div>" : '<div class="dc-personal dc-personal-empty">个人归因待你补 —— AI 不替你判断「为什么重要」</div>') +
    '<div class="dc-tags">' + (c.tags || []).map(t => '<span class="dc-tag">' + esc(t) + "</span>").join("") + "</div>" +
    '<div class="dc-recall-row"><span class="recall-toggle" data-id="' + c.id + '"><span class="recall-switch"></span><span>开启回忆</span></span></div>' +
    '<div class="dc-actions">' +
    '<button class="dc-btn confirm" data-id="' + c.id + '">确认保存</button>' +
    '<button class="dc-btn edit" data-id="' + c.id + '">编辑</button>' +
    '<button class="dc-btn skip" data-id="' + c.id + '">跳过</button>' +
    "</div></div>"
  ).join("");
  container.innerHTML = html;
  container.querySelectorAll(".dc-btn.confirm").forEach(b => {
    b.onclick = async () => {
      await api("/api/cards/" + b.dataset.id + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      b.closest(".draft-card").style.opacity = "0.5"; b.textContent = "已保存 ✓"; b.disabled = true;
      await loadCards(); await loadLedger(); await loadRecall();
    };
  });
  container.querySelectorAll(".dc-btn.edit").forEach(b => { b.onclick = () => { const card = drafts.find(c => c.id == b.dataset.id); openEditModal(card); }; });
  container.querySelectorAll(".dc-btn.skip").forEach(b => { b.onclick = async () => {
    await api("/api/cards/" + b.dataset.id, { method: "DELETE" });
    b.closest(".draft-card").remove();
    if (!container.querySelectorAll(".draft-card").length) container.innerHTML = "";
}; });
  container.querySelectorAll(".recall-toggle").forEach(function(t) {
    t.classList.toggle("on", false);
    t.onclick = function(e) { e.stopPropagation(); toggleRecall(t.dataset.id, !t.classList.contains("on"), t); };
  });
}

// ---- Library ----
async function loadCards() {
  const data = await api("/api/cards");
  cards = data.cards;
  const batchData = await api("/api/folders");
  batches = batchData.folders;
  renderFilters();
  renderLibrary();
}

function renderFilters() {
  const scenes = {};
  cards.forEach(c => { scenes[c.scene_type] = (scenes[c.scene_type] || 0) + 1; });
  const filters = document.getElementById("libraryFilters");
  let html = '<div class="filter-chip folder-chip' + (currentFilter === "folders" ? " active" : "") + '" data-f="folders">📁 文件夹</div>';
  html += '<div class="filter-chip' + (currentFilter === "all" ? " active" : "") + '" data-f="all">全部 ' + cards.length + "</div>";
  for (const s of scenarios) {
    if (scenes[s.key]) {
      html += '<div class="filter-chip' + (currentFilter === s.key ? " active" : "") + '" data-f="' + s.key + '">' + s.name + " " + scenes[s.key] + "</div>";
    }
  }
  filters.innerHTML = html;
  filters.querySelectorAll(".filter-chip").forEach(el => {
    el.onclick = () => { currentFilter = el.dataset.f; if (batchMode) { batchMode = false; selectedIds = {}; resetBatchButton(); } renderFilters(); renderLibrary(); };
  });
}

function renderLibrary() {
  const grid = document.getElementById("cardGrid");
  const count = document.getElementById("libraryCount");
  if (currentFilter === "folders") { renderFolderView(); return; }
  const filtered = currentFilter === "all" ? cards : cards.filter(c => c.scene_type === currentFilter);
  count.textContent = filtered.length + " 张卡片";
  if (!filtered.length) { grid.innerHTML = emptyHint("暂无记忆卡片"); return; }
  grid.innerHTML = filtered.map(c => cardHtml(c)).join("");
  bindCardEvents(grid);
}

// ---- Folder view ----
function renderFolderView() {
  const grid = document.getElementById("cardGrid");
  const count = document.getElementById("libraryCount");
  count.textContent = batches.length + " 个文件夹";
  if (!batches.length) { grid.innerHTML = emptyHint("暂无文件夹，生成卡片后会自动创建"); return; }
  var allIds = [];
  grid.innerHTML = batches.map(function(b) {
    const folderCards = cards.filter(function(c) { return c.batch_id === b.batch_id && c.status !== "deleted"; });
    const sName = (scenarios.find(function(s) { return s.key === b.scene_type; }) || {}).name || b.scene_type;
    const dispTitle = b.is_unfiled ? "未分类" : (b.name || b.title || sName);
    var fc = folderCards;
    // in batch mode, track all card ids
    if (batchMode) fc.forEach(function(c){ if(allIds.indexOf(String(c.id))<0) allIds.push(String(c.id)); });
    var folderAllSelected = batchMode && fc.length && fc.every(function(c){ return selectedIds[c.id]; });
    var folderIcon = b.is_unfiled ? '<span class="batch-icon">📦</span>' : (batchMode ? '<span class="folder-check' + (folderAllSelected ? " on" : "") + '" data-folder="' + esc(b.batch_id) + '">✓</span>' : '<span class="batch-icon">📁</span>');
    return '<div class="batch-folder' + (batchMode ? " batch-on" : "") + '" data-batch="' + esc(b.batch_id) + '">' +
      '<div class="batch-header">' +
        folderIcon +
        '<span class="batch-scene scene-' + b.scene_type + '">' + esc(sName) + '</span>' +
        '<span class="batch-title">' + esc(dispTitle) + "</span>" +
        '<span class="batch-meta">' + esc(b.source_date || "") + ' · ' + fc.length + " 张</span>" +
        '<span class="batch-actions">' +
          '<button class="batch-act" data-act="rename" data-batch="' + esc(b.batch_id) + '" title="重命名">✎</button>' +
          '<button class="batch-act" data-act="merge" data-batch="' + esc(b.batch_id) + '" title="合并到…">⇄</button>' +
          '<button class="batch-act" data-act="delete" data-batch="' + esc(b.batch_id) + '" title="删除">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="batch-cards" id="batch-' + esc(b.batch_id) + '">' +
        '<div class="card-grid">' + fc.map(function(c) { return cardHtml(c); }).join("") + '</div>' +
      '</div>' +
    '</div>';
  }).join("");
  grid.querySelectorAll(".batch-header").forEach(function(h) {
    h.onclick = function(e) {
      if (e.target.closest(".recall-toggle") || e.target.closest(".batch-actions") || e.target.closest(".card-move-row") || e.target.closest(".card-check")) return;
      if (e.target.closest(".folder-check")) { e.stopPropagation(); toggleFolderSelect(h.parentNode.dataset.batch); return; }
      const fid = h.parentNode.dataset.batch;
      const cd = document.getElementById("batch-" + fid);
      const open = cd.style.display !== "none";
      cd.style.display = open ? "none" : "block";
      if (h.classList) h.classList.toggle("expanded", !open);
    };
  });
  grid.querySelectorAll(".folder-check").forEach(function(chk) {
    chk.onclick = function(e) { e.stopPropagation(); toggleFolderSelect(chk.dataset.folder); };
  });
  // Use event delegation for batch-act buttons
  grid.onclick = function(e) {
    var btn = e.target.closest(".batch-act");
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    var act = btn.dataset.act;
    var fid = btn.dataset.batch;
    if (act === "rename") showRenameModal(fid);
    else if (act === "merge") showMergeModal(fid);
    else if (act === "delete") confirmDeleteFolder(fid);
  };
  // in batch mode expand all, else collapse all
  grid.querySelectorAll(".batch-cards").forEach(function(cd){ cd.style.display = batchMode ? "block" : "none"; });
  bindCardEvents(grid);
}

function bindCardEvents(grid) {
  grid.querySelectorAll(".mem-card").forEach(function(el) {
    el.onclick = function(e) {
      if (e.target.closest(".recall-toggle") || e.target.closest(".card-move-row")) return;
      if (batchMode) { e.stopPropagation(); toggleCardSelect(el.dataset.id); return; }
      const card = cards.find(function(c) { return c.id == el.dataset.id; });
      if (card) openCardModal(card);
    };
  });
  grid.querySelectorAll(".mem-recall-toggle").forEach(function(t) {
    t.onclick = function(e) { e.stopPropagation(); toggleRecall(t.dataset.id, !t.classList.contains("on"), t); };
  });
  grid.querySelectorAll(".card-move-sel").forEach(function(sel) {
    sel.onclick = function(e) { e.stopPropagation(); };
    sel.onchange = function(e) { e.stopPropagation(); var cid = sel.dataset.id; var target = sel.value; if (target === "__placeholder") return; moveCardTo(cid, target); };
  });
}

function cardHtml(c) {
  const sName = (scenarios.find(function(s) { return s.key === c.scene_type; }) || {}).name || c.scene_type;
  let img = isVideoUrl(c.image_url) ? '<video class="mem-card-img" src="' + c.image_url + '" muted></video>' : (c.image_url ? '<img class="mem-card-img" src="' + c.image_url + '" alt="">' : "");
  let selCls = selectedIds[c.id] ? " selected" : "";
  let chk = batchMode ? '<span class="card-check' + (selectedIds[c.id] ? " on" : "") + '" data-id="' + c.id + '">✓</span>' : "";
  let recall = '<span class="recall-toggle mem-recall-toggle ' + (c.recall_enabled ? "on" : "") + '" data-id="' + c.id + '"><span class="recall-switch"></span><span>' + (c.recall_enabled ? ("复习 " + (c.recall_count || 0)) : "开启回忆") + '</span></span>';
  let moveRow = "";
  if (!batchMode) {
    var opts = '<option value="__placeholder">移动到…</option>';
    batches.forEach(function(b) { if (b.batch_id !== c.batch_id) opts += '<option value="' + b.batch_id + '">' + esc(b.name || b.title || b.scene_type) + '</option>'; });
    opts += '<option value="" ' + (c.batch_id === "" ? "disabled" : "") + '>未分类</option>';
    moveRow = '<div class="mem-card-move"><span class="card-move-row"><select class="card-move-sel" data-id="' + c.id + '">' + opts + '</select></span></div>';
  }
  const dueCls = recallQueue.some(q => String(q.id) === String(c.id)) ? " due" : "";
  const dueBadge = dueCls ? '<span class="mem-card-due">待复习</span>' : "";
  return '<div class="mem-card' + (batchMode ? " batch-on" : "") + selCls + dueCls + '" data-id="' + c.id + '">' +
    img + chk + dueBadge +
    '<div class="mem-card-body">' +
    '<span class="mem-card-scene scene-' + c.scene_type + '">' + esc(sName) + "</span>" +
    '<div class="mem-card-title">' + esc(c.title) + "</div>" +
    '<div class="mem-card-summary">' + esc(c.summary) + "</div>" +
    (c.personal ? '<div class="mem-card-personal">' + esc(c.personal) + "</div>" : '<div class="mem-card-personal-empty">✎ 补充个人归因</div>') +
    '<div class="mem-card-tags">' + (c.tags || []).map(function(t) { return '<span class="mem-card-tag">' + esc(t) + "</span>"; }).join("") + "</div>" +
    "</div>" +
    '<div class="mem-card-footer"><span>' + (c.source_date || "") + "</span>" + recall + "</div>" +
    moveRow +
    "</div>";
}

function emptyHint(key) {
  return '<div class="lib-empty">' + key + "</div>";
}

// ---- Folder actions ----
function showRenameModal(fid) {
  var b = batches.find(function(x) { return x.batch_id === fid; });
  if (!b) { alert("文件夹未找到"); return; }
  var cur = b.name || b.title || "";
  var body = document.getElementById("modalBody");
  body.innerHTML =
    "<div class='modal-body'>" +
    "<div class='modal-title'>重命名文件夹</div>" +
    "<div class='modal-section'><div class='modal-section-label'>新名称</div>" +
    "<input class='personalization-input' id='renameInput' value='" + escAttr(cur) + "'></div>" +
    "<div style='display:flex;gap:8px;margin-top:12px'>" +
    "<button class='btn-primary' id='renameOK' style='flex:1'>确定</button>" +
    "<button class='btn-primary' id='renameCancel' style='flex:0;background:var(--bg-card);color:var(--ink);border:1px solid var(--line)'>取消</button>" +
    "</div></div>";
  document.getElementById("cardModal").classList.add("show");
  document.getElementById("renameOK").onclick = function() {
    var nv = document.getElementById("renameInput").value.trim();
    if (!nv) { alert("名称不能为空"); return; }
    closeModal();
    fetch("/api/folders/" + encodeURIComponent(fid), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nv }) }).then(function() { return loadCards(); });
  };
  document.getElementById("renameCancel").onclick = function() { closeModal(); };
  setTimeout(function() { var inp = document.getElementById("renameInput"); if(inp) inp.focus(); }, 100);
}
function showMergeModal(fid) {
  var targets = batches.filter(function(b) { return b.batch_id !== fid; });
  if (!targets.length) { alert("没有其他文件夹可合并"); return; }
  var opts = "";
  targets.forEach(function(t) { opts += "<option value='" + t.batch_id + "'>" + esc(t.name || t.title || t.scene_type) + " (" + t.card_count + " 张)</option>"; });
  var body = document.getElementById("modalBody");
  body.innerHTML =
    "<div class='modal-body'>" +
    "<div class='modal-title'>合并到其他文件夹</div>" +
    "<div class='modal-section'><div class='modal-section-label'>选择目标文件夹</div>" +
    "<select class='folder-pick' id='mergePick'>" + opts + "</select></div>" +
    "<p style='font-size:12px;color:var(--ink-faint);margin-top:4px'>当前文件夹中的卡片将全部移动到目标文件夹，当前文件夹将被删除。</p>" +
    "<div style='display:flex;gap:8px;margin-top:12px'>" +
    "<button class='btn-primary' id='mergeOK' style='flex:1'>确定合并</button>" +
    "<button class='btn-primary' id='mergeCancel' style='flex:0;background:var(--bg-card);color:var(--ink);border:1px solid var(--line)'>取消</button>" +
    "</div></div>";
  document.getElementById("cardModal").classList.add("show");
  document.getElementById("mergeOK").onclick = function() {
    var targetId = document.getElementById("mergePick").value;
    if (!targetId) { alert("请选择目标文件夹"); return; }
    closeModal();
    fetch("/api/folders/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_id: fid, target_id: targetId }) }).then(function() { return loadCards(); });
  };
  document.getElementById("mergeCancel").onclick = function() { closeModal(); };
}
function confirmDeleteFolder(fid) {
  var b = batches.find(function(x) { return x.batch_id === fid; });
  if (!b) { alert("文件夹未找到"); return; }
  var name = b.name || b.title || "";
  if (!confirm("确定删除文件夹「" + name + "」？\n卡片将移到「未分类」。")) return;
  var wipe = confirm("是否同时删除文件夹内的所有卡片？\n点「取消」则仅删文件夹、卡片移到「未分类」。");
  fetch("/api/folders/" + encodeURIComponent(fid) + "?delete_cards=" + (wipe ? "true" : "false"), { method: "DELETE" }).then(function() { return loadCards(); }).then(function() { loadLedger(); loadRecall(); });
}
function moveCardTo(cardId, folderId) {
  fetch("/api/cards/" + cardId + "/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: folderId }) }).then(function() { return loadCards(); });
}

// ---- Batch management ----
function setupBatch() {
  var btn = document.getElementById("batchToggle");
  if (btn) btn.onclick = function() { toggleBatchMode(!batchMode); };
}
function resetBatchButton() {
  var btn = document.getElementById("batchToggle");
  if (btn) { btn.textContent = "批量管理"; btn.classList.remove("active"); }
}
function toggleBatchMode(on) {
  batchMode = on;
  selectedIds = {};
  var btn = document.getElementById("batchToggle");
  if (btn) { btn.textContent = on ? "退出批量" : "批量管理"; btn.classList.toggle("active", on); }
  renderBatchToolbar();
  renderLibrary();
}
function renderBatchToolbar() {
  var tb = document.getElementById("batchToolbar");
  if (!tb) return;
  if (!batchMode) { tb.style.display = "none"; tb.innerHTML = ""; return; }
  var n = selectedIdList().length;
  var visible = getVisibleCardIds();
  var allOn = visible.length && visible.every(function(id){ return selectedIds[id]; });
  tb.style.display = "flex";
  tb.innerHTML =
    '<span class="bt-count">已选 <b>' + n + '</b> 张</span>' +
    '<button class="bt-btn" id="btSelectAll">' + (allOn ? "取消全选" : "全选") + "</button>" +
    '<span class="bt-sep"></span>' +
    '<button class="bt-btn bt-primary" id="btMove">📂 移入文件夹</button>' +
    '<button class="bt-btn bt-danger" id="btDelete">🗑 删除</button>' +
    '<span class="bt-spacer"></span>' +
    '<button class="bt-btn" id="btExit">完成</button>';
  document.getElementById("btSelectAll").onclick = function() {
    visible.forEach(function(id){ if (allOn) delete selectedIds[id]; else selectedIds[id] = true; });
    renderBatchToolbar(); renderLibrary();
  };
  document.getElementById("btMove").onclick = batchMoveSelected;
  document.getElementById("btDelete").onclick = batchDeleteSelected;
  document.getElementById("btExit").onclick = function() { toggleBatchMode(false); };
}
function getVisibleCardIds() {
  var grid = document.getElementById("cardGrid");
  var ids = [];
  if (grid) grid.querySelectorAll(".mem-card").forEach(function(el){ ids.push(String(el.dataset.id)); });
  return ids;
}
function toggleCardSelect(id) {
  id = String(id);
  if (selectedIds[id]) delete selectedIds[id]; else selectedIds[id] = true;
  renderBatchToolbar(); renderLibrary();
}
function selectedIdList() { return Object.keys(selectedIds).filter(function(k){ return selectedIds[k]; }); }
function batchMoveSelected() {
  var ids = selectedIdList();
  if (!ids.length) { alert("请先勾选要移动的卡片"); return; }
  var opts = "";
  batches.forEach(function(b){ opts += '<option value="' + b.batch_id + '">' + esc(b.name || b.title || b.scene_type) + "</option>"; });
  opts += '<option value="">未分类</option>';
  showFolderPicker("将 " + ids.length + " 张卡片移入", opts, function(fid){
    if (fid === null) return;
    fetch("/api/batch/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_ids: ids, folder_id: fid }) }).then(function(){ toggleBatchMode(false); return loadCards(); });
  });
}
function toggleFolderSelect(fid) {
  var folderCards = cards.filter(function(c) { return c.batch_id === fid && c.status !== "deleted"; });
  var allSelected = folderCards.length && folderCards.every(function(c){ return selectedIds[c.id]; });
  folderCards.forEach(function(c){ if (allSelected) delete selectedIds[c.id]; else selectedIds[c.id] = true; });
  renderBatchToolbar(); renderFolderView();
}

function batchDeleteSelected() {
  var ids = selectedIdList();
  if (!ids.length) { alert("请先勾选要删除的卡片"); return; }
  if (!confirm("确定删除选中的 " + ids.length + " 张卡片？此操作不可撤销。")) return;
  fetch("/api/batch/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_ids: ids }) }).then(function(){ toggleBatchMode(false); return loadCards(); }).then(function(){ loadLedger(); loadRecall(); });
}
function showFolderPicker(title, optsHTML, callback) {
  var body = document.getElementById("modalBody");
  body.innerHTML =
    '<div class="modal-body">' +
    '<div class="modal-title">' + esc(title) + '</div>' +
    '<select class="folder-pick" id="folderPick">' + optsHTML + '</select>' +
    '<div style="display:flex;gap:8px;margin-top:8px">' +
    '<button class="btn-primary" id="fpOK" style="flex:1">确定</button>' +
    '<button class="btn-primary" id="fpCancel" style="flex:0;background:var(--bg-card);color:var(--ink);border:1px solid var(--line)">取消</button>' +
    '</div></div>';
  document.getElementById("cardModal").classList.add("show");
  document.getElementById("fpOK").onclick = function() { var v = document.getElementById("folderPick").value; closeModal(); callback(v); };
  document.getElementById("fpCancel").onclick = function() { closeModal(); callback(null); };
}

// ---- Ledger ----
async function loadLedger() {
  const stats = await api("/api/ledger");
  const grid = document.getElementById("ledgerGrid");
  const sceneNames = {}; scenarios.forEach(s => sceneNames[s.key] = s.name);
  const colors = { enterprise: "#0F766E", museum: "#B45309", meeting: "#7C3AED", class: "#2563EB", travel: "#DB2777", custom: "#525252" };
  const aiSecs = stats.total_analysis_seconds || 0;
  const recallSecs = stats.total_recall_seconds || 0;
  const aiTxt = aiSecs >= 60 ? (aiSecs / 60).toFixed(1) + " min" : Math.round(aiSecs) + " s";
  const recallTxt = recallSecs >= 60 ? (recallSecs / 60).toFixed(1) + " min" : Math.round(recallSecs) + " s";
  let html = '<div class="ledger-stat"><div class="ledger-num">' + stats.total_cards + '</div><div class="ledger-label">记忆卡片总数</div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.total_materials + '</div><div class="ledger-label">已处理素材数</div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.recall_done + "/" + stats.recall_total + '</div><div class="ledger-label">回忆完成率<span class="ledger-sub">' + (stats.recall_sessions || 0) + " 次复习 · 平均难度 " + (stats.avg_difficulty || 0) + "</span></div></div>";
  html += '<div class="ledger-stat"><div class="ledger-num">' + aiTxt + '</div><div class="ledger-label">AI 实际处理时长<span class="ledger-sub">按本次会话真实计时</span></div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + recallTxt + '</div><div class="ledger-label">复习投入时长<span class="ledger-sub">基于回忆挑战计时</span></div></div>';
  var quick = stats.quick_mode_count || 0, deep = stats.deep_mode_count || 0;
  if (quick + deep > 0) {
    html += '<div class="ledger-stat"><div class="ledger-num">' + quick + '<span style="font-size:0.6em;color:var(--ink-faint)">/' + deep + '</span></div><div class="ledger-label">快速 / 深度<span class="ledger-sub">快速记录跳过筛选，深度筛选留存</span></div></div>';
  }
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.total_minutes_saved + '<span class="unit"> min</span></div><div class="ledger-label">估算节省<span class="ledger-sub">按场景系数，仅供对照</span></div></div>';
  const maxScene = Math.max(...Object.values(stats.by_scene), 1);
  html += '<div class="ledger-bar-section"><div class="ledger-bar-title">按场景分布</div>';
  for (const [key, cnt] of Object.entries(stats.by_scene)) {
    html += '<div class="bar-row"><div class="bar-label">' + esc(sceneNames[key] || key) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + (cnt / maxScene * 100) + "%;background:" + (colors[key] || "#525252") + '"></div></div><div class="bar-num">' + cnt + "</div></div>";
  }
  html += "</div>";
  grid.innerHTML = html;
}

// ---- Recall ----
async function loadRecall() {
  const data = await api("/api/recall/due");
  recallQueue = data.cards; recallIndex = 0;
  const badge = document.getElementById("recallBadge");
  badge.textContent = recallQueue.length > 0 ? recallQueue.length : "";
  renderRecall();
  maybeNotifyRecall();
}
function renderRecall() {
  const container = document.getElementById("recallContainer");
  if (!recallQueue.length) { container.innerHTML = '<div class="recall-empty"><p>🎉 暂无需要回忆的卡片</p><p style="margin-top:8px">所有复习都已完成，或当前场景未开启回忆功能</p></div>'; return; }
  if (recallIndex >= recallQueue.length) { container.innerHTML = '<div class="recall-empty"><p>✅ 今天的回忆挑战已全部完成！</p><p style="margin-top:8px">明天再来巩固记忆吧</p></div>'; return; }
  const card = recallQueue[recallIndex]; const progress = recallIndex + 1;
  recallStartTs = Date.now();
  container.innerHTML =
    '<div class="recall-intro">第 ' + progress + " / " + recallQueue.length + ' 张 · 基于间隔重复算法，在遗忘临界点主动发起回忆</div>' +
    '<div class="recall-card">' +
    (card.image_url ? mediaTag(card.image_url, 'recall-clue-media', 'style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-bottom:12px"') : '') +
    '<div class="recall-prompt-label">回忆提示</div>' +
    '<div class="recall-hint">' + getRecallHint(card) + "</div>" +
    '<div class="recall-prompt-label">先默写你记得的内容</div>' +
    '<textarea class="recall-try" id="recallTry" placeholder="不看答案，把你能想起来的写下来——这一步本身就在加固记忆" rows="3"></textarea>' +
    '<button class="reveal-btn" id="revealBtn">揭晓答案</button>' +
    '<div class="recall-reveal" id="recallReveal">' +
    '<div class="recall-reveal-title">' + esc(card.title) + "</div>" +
    '<div class="recall-reveal-body">' + esc(card.summary) + "</div>" +
    (card.personal ? '<div class="recall-reveal-body" style="color:var(--amber);font-style:italic">' + esc(card.personal) + "</div>" : "") +
    '<div class="recall-prompt-label">回忆难度（影响下次间隔）</div>' +
    '<div class="recall-actions">' +
    '<button class="recall-diff-btn easy" data-d="0">简单 → 拉长间隔</button>' +
    '<button class="recall-diff-btn medium" data-d="1">中等</button>' +
    '<button class="recall-diff-btn hard" data-d="2">困难 → 缩短间隔</button>' +
    "</div></div></div>";
  document.getElementById("revealBtn").onclick = () => { var tryText = (document.getElementById("recallTry").value || "").trim(); var reveal = document.getElementById("recallReveal"); if (tryText) { var cmp = document.createElement("div"); cmp.className = "recall-mine"; cmp.innerHTML = '<div class="recall-prompt-label">你刚才写的</div><div class="recall-reveal-body recall-reveal-mine">' + esc(tryText) + '</div>'; reveal.insertBefore(cmp, reveal.firstChild); } reveal.classList.add("show"); document.getElementById("revealBtn").style.display = "none"; };
  var _startTs = recallStartTs;
  container.querySelectorAll(".recall-diff-btn").forEach(b => {
    b.onclick = async () => {
      const secs = Math.max(1, Math.round((Date.now() - _startTs) / 1000));
      await api("/api/recall/" + card.id + "/attempt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ difficulty: parseInt(b.dataset.d), seconds: secs }) });
      recallIndex++; renderRecall(); await loadCards(); await loadLedger();
    };
  });
}
function getRecallHint(card) {
  if (card.tags && card.tags.length) return "关于「" + card.tags[0] + "」，你记得什么？";
  return "你记得关于这张卡片的什么内容？";
}

// ---- Modal ----
function openCardModal(card) {
  const body = document.getElementById("modalBody");
  let html = '<div class="modal-body modal-body-content">';
  if (card.image_url) html += mediaTag(card.image_url, 'style="width:100%;max-height:400px;object-fit:contain;border-radius:8px;margin-bottom:16px"');
  html += '<div class="modal-title">' + esc(card.title) + "</div>";
  html += '<div class="modal-section"><div class="modal-section-label">客观总结</div><div class="modal-section-text">' + esc(card.summary) + "</div></div>";
  html += '<div class="modal-section"><div class="modal-section-label">个人归因</div>' + (card.personal ? '<div class="modal-section-text" style="color:var(--amber);font-style:italic">' + esc(card.personal) + "</div>" : '<div class="modal-section-text" style="color:var(--ink-faint)">待你补充 —— AI 留空了这里</div>') + "</div>";
  if (card.tags && card.tags.length) { html += '<div class="modal-section"><div class="modal-section-label">标签</div><div class="mem-card-tags">' + card.tags.map(t => '<span class="mem-card-tag">' + esc(t) + "</span>").join("") + "</div></div>"; }
  html += '<div class="modal-section"><div class="modal-section-label">日期</div><div class="modal-section-text">' + (card.source_date || "") + "</div></div>";
  html += '<div class="modal-section conn-section" id="connSection"><div class="modal-section-label">相关记忆</div><div class="conn-loading">寻找碎片之间的联系…</div></div>';
  if (card.recall_enabled) { html += '<div class="modal-section"><div class="modal-section-label">复习状态</div><div class="modal-section-text">已复习 ' + (card.recall_count || 0) + " 次 · 下次复习：" + (card.next_recall || "待定") + "</div></div>"; }
  html += '<div class="modal-actions"><button class="modal-btn" onclick="closeModal();setTimeout(function(){var c=cards.find(function(x){return x.id==' + card.id + '});if(c)openEditModal(c);},200)">✎ 编辑</button><button class="modal-btn modal-btn-danger" onclick="deleteCard(' + card.id + ')">删除</button></div></div>';
  body.innerHTML = html;
  document.getElementById("cardModal").classList.add("show");
  loadConnections(card.id);
}
function openEditModal(card) {
  const body = document.getElementById("modalBody");
  body.innerHTML =
    '<div class="modal-body"><div class="modal-title">编辑记忆卡片</div>' +
    '<div class="modal-section"><div class="modal-section-label">标题</div><input class="personalization-input" id="editTitle" value="' + escAttr(card.title) + '"></div>' +
    '<div class="modal-section"><div class="modal-section-label">客观总结</div><textarea class="notes-input" id="editSummary" rows="3">' + escAttr(card.summary) + "</textarea></div>" +
    '<div class="modal-section"><div class="modal-section-label">个人归因</div><textarea class="notes-input" id="editPersonal" rows="2">' + escAttr(card.personal) + "</textarea></div>" +
    '<div class="modal-section"><div class="modal-section-label">标签</div><input class="personalization-input" id="editTags" value="' + escAttr((card.tags || []).join(", ")) + '" placeholder="多个标签用逗号分隔"></div>' +
    '<div class="modal-section"><div class="modal-section-label">回忆</div><span class="recall-toggle ' + (card.recall_enabled ? "on" : "") + '" id="editRecallToggle"><span class="recall-switch"></span><span>' + (card.recall_enabled ? "已开启" : "点击开启") + '</span></span></div>' +
    '<button class="btn-primary" id="saveEdit">保存</button></div>';
  document.getElementById("cardModal").classList.add("show");
  var editToggle = document.getElementById("editRecallToggle");
  if (editToggle) editToggle.onclick = function() { var on = !editToggle.classList.contains("on"); editToggle.classList.toggle("on", on); editToggle.querySelector("span:last-child").textContent = on ? "已开启" : "点击开启"; };
  document.getElementById("saveEdit").onclick = async () => {
    await api("/api/cards/" + card.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recall_enabled: !!document.getElementById("editRecallToggle") && document.getElementById("editRecallToggle").classList.contains("on"), title: document.getElementById("editTitle").value, summary: document.getElementById("editSummary").value, personal: document.getElementById("editPersonal").value, tags: (document.getElementById("editTags").value || "").split(",").map(t => t.trim()).filter(t => t), status: "confirmed" }) });
    closeModal(); await loadCards();
  };
}
async function loadConnections(cardId) {
  var sec = document.getElementById("connSection");
  if (!sec) return;
  try {
    var d = await api("/api/cards/" + cardId + "/connections");
    var conns = d.connections || [];
    if (!conns.length) { sec.innerHTML = '<div class="modal-section-label">相关记忆</div><div class="conn-empty">暂未发现与其他记忆的联系——试试为卡片补充标签</div>'; return; }
    var sceneName = {}; scenarios.forEach(function(s){ sceneName[s.key]=s.name; });
    var html = '<div class="modal-section-label">相关记忆</div>' + conns.map(function(c){
      var tagPart = (c.shared_tags||[]).length ? '<span class="conn-via">' + (c.shared_tags||[]).map(function(t){return '#'+esc(t);}).join(' ') + '</span>' : '';
      var aiPart = c.ai_reason ? '<span class="conn-ai-reason">🧠 ' + esc(c.ai_reason) + '</span>' : '';
      var itemCls = c.ai_reason ? 'conn-item conn-ai' : 'conn-item';
      return '<div class="' + itemCls + '" data-id="' + c.id + '"><span class="conn-scene scene-' + c.scene_type + '">' + esc(sceneName[c.scene_type]||c.scene_type) + '</span>'
        + '<span class="conn-title">' + esc(c.title) + '</span>'
        + tagPart + aiPart + '</div>';
    }).join('');
    sec.innerHTML = html;
    sec.querySelectorAll('.conn-item').forEach(function(el){ el.onclick=function(){ var id=el.dataset.id; var c=conns.find(function(x){return String(x.id)===id;}); if(c){ openCardModal(c); } }; });
  } catch(e){ sec.innerHTML = '<div class="modal-section-label">相关记忆</div><div class="conn-empty">联系加载失败</div>'; }
}

function closeModal() { document.getElementById("cardModal").classList.remove("show"); }
document.getElementById("cardModal").onclick = e => { if (e.target.id === "cardModal") closeModal(); };

// ---- Utils ----
function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u200b-\u200f\u2028-\u202e\u00a0\u3000\ufeff]/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
function escAttr(s) { if (!s) return ""; return esc(s); }

// ---- Delete / recall toggle ----
async function deleteCard(cardId) {
  if (!confirm("确定删除这张卡片吗？")) return;
  await api("/api/cards/" + cardId, { method: "DELETE" });
  closeModal(); await loadCards(); await loadLedger(); await loadRecall();
}
async function toggleRecall(cardId, on, el) {
  await api("/api/cards/" + cardId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recall_enabled: on }) });
  if (el) { el.classList.toggle("on", on); var label = el.querySelector("span:last-child"); if (label) label.textContent = on ? "已开启回忆" : "开启回忆"; }
  await loadCards(); await loadLedger(); await loadRecall();
}

// ---- Multi-profile ----
async function loadProfiles() {
  const d = await api("/api/profiles");
  const sel = document.getElementById("profileSelect");
  if (!sel) return;
  sel.innerHTML = d.profiles.map(p =>
    '<option value="' + escAttr(p.name) + '"' + (p.name === profileName() ? " selected" : "") + ">" +
    esc(p.name) + "（" + p.card_count + " 张）</option>"
  ).join("");
  sel.onchange = () => switchProfile(sel.value);
  const nb = document.getElementById("profileNewBtn");
  if (nb) nb.onclick = () => {
    const name = prompt("新建档案名称（建议用英文或数字，例如 family）");
    if (!name || !name.trim()) return;
    switchProfile(name.trim());
  };
}
async function switchProfile(name) {
  localStorage.setItem("presenceProfile", name);
  document.cookie = "presence_profile=" + encodeURIComponent(name) + "; path=/; SameSite=Lax";
  await api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) });
  await loadProfiles();
  await Promise.all([loadCards(), loadLedger(), loadRecall(), loadGraph()]);
}
function setupProfile() {
  if (!document.cookie.split("; ").some(c => c.indexOf("presence_profile=") === 0)) {
    document.cookie = "presence_profile=" + encodeURIComponent(profileName()) + "; path=/; SameSite=Lax";
  }
  loadProfiles().catch(() => {});
}

// ---- PWA Share Target Receiver ----
async function handleSharedContent() {
  var params = new URLSearchParams(location.search);
  if (!params.get("shared")) return;
  // Clean the URL so it does not re-trigger on refresh
  history.replaceState(null, "", location.pathname);
  if (!("caches" in window)) return;
  try {
    var cache = await caches.open("presence-shared");
    var resp = await cache.match("/__shared_manifest");
    if (!resp) return;
    var manifest = await resp.json();
    // Restore shared files from cache as File objects
    var restoredFiles = [];
    for (var fi of (manifest.files || [])) {
      var fileResp = await cache.match(fi.cacheKey);
      if (!fileResp) continue;
      var blob = await fileResp.blob();
      restoredFiles.push(new File([blob], fi.name || "shared_file", { type: fi.type }));
    }
    // Clean up the shared cache
    await cache.delete("/__shared_manifest");
    for (var fi2 of (manifest.files || [])) {
      await cache.delete(fi2.cacheKey);
    }
    // Populate the capture UI
    if (restoredFiles.length) {
      selectedFiles = restoredFiles;
      renderFileList();
    }
    if (manifest.text) {
      var notesEl = document.getElementById("notesInput");
      if (notesEl) notesEl.value = manifest.text;
    }
    // Switch to capture tab and notify
    var captureTab = document.querySelector(".tab[data-tab=capture]");
    if (captureTab) captureTab.click();
    var statusMsg = restoredFiles.length + " \u4e2a\u6587\u4ef6\u5df2\u5bfc\u5165\u91c7\u96c6\u533a\uff0c\u9009\u62e9\u573a\u666f\u540e\u70b9\u51fb\u751f\u6210\u5361\u7247";
    var draftEl = document.getElementById("draftCards");
    if (draftEl) {
      draftEl.innerHTML = '<div class="draft-card" style="border-color:var(--amber)"><div class="dc-title">\u2728 \u521a\u4ece\u7cfb\u7edf\u5206\u4eab\u63a5\u6536</div><div class="dc-summary">' + statusMsg + '</div></div>';
    }
  } catch (e) {
    console.warn("[share] restore failed:", e);
  }
}

// ---- PWA ----
let deferredInstallPrompt = null;
function setupPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/static/sw.js").catch(function(){});
  }
  window.addEventListener("beforeinstallprompt", function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById("installBtn");
    if (btn) btn.style.display = "inline-flex";
  });
  const btn = document.getElementById("installBtn");
  if (btn) btn.onclick = async function() {
    if (!deferredInstallPrompt) { alert("当前浏览器可以直接「添加到主屏幕」使用。"); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btn.style.display = "none";
  };
}

// ---- Notifications ----
function setupNotifications() {
  document.addEventListener("click", function once() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(function(){});
    }
    document.removeEventListener("click", once);
  });
}
function maybeNotifyRecall() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!recallQueue.length || !document.hidden) return;
  try {
    new Notification("在场 — 回忆提醒", { body: "今天有 " + recallQueue.length + " 张卡片等待复习", icon: "/static/assets/icon-192.png" });
  } catch (e) {}
}

// ---- Semantic Connections ----
async function discoverConnections(btn) {
  if (!confirm("让 AI 扫描全库，发现跨场景的深层联结？\n这会发送卡片摘要给 AI 处理。")) return;
  var orig = btn.textContent;
  btn.disabled = true; btn.textContent = "🧠 AI 正在发现联结…";
  try {
    var d = await api("/api/connections/discover", { method: "POST" });
    if (d.ai_used) {
      var msg = "✨ 新增 " + d.discovered + " 条联结";
      if (d.total > d.discovered) msg += "（本次共发现 " + d.total + " 条，其中 " + (d.total - d.discovered) + " 条已存在）";
      msg += "。\n点击联结线可锁定/解锁，锁定的不会被清除。";
      alert(msg);
      if (typeof loadGraph === "function") loadGraph();
    } else {
      alert("⚠️ 未接入 AI，无法发现联结。\n请配置 API Key 后再试。");
    }
  } catch (e) {
    alert("发现联结失败：" + e.message);
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

// ---- Graph ----
function toggleConnectionLock(cardA, cardB) {
  return api("/api/connections/lock", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ card_a: cardA, card_b: cardB })
  }).then(function(res) { return res.locked; });
}
function setupGraph() {
  const btn = document.getElementById("graphRefreshBtn");
  if (btn) btn.onclick = () => loadGraph();
  const dBtn = document.getElementById("discoverConnBtn");
  if (dBtn) dBtn.onclick = () => discoverConnections(dBtn);

  const clearBtn = document.getElementById("clearConnBtn");
  if (clearBtn) clearBtn.onclick = () => {
    if (!confirm("清除未锁定的 AI 联结？\n已锁定的联结会保留。\n这不会影响你的卡片。")) return;
    clearBtn.disabled = true; clearBtn.textContent = "清除中…";
    api("/api/connections", { method: "DELETE" }).then(function() {
      clearBtn.style.display = "none";
      if (typeof loadGraph === "function") loadGraph();
    }).catch(function(e) {
      alert("清除失败：" + e.message);
    }).finally(function() {
      clearBtn.disabled = false; clearBtn.textContent = "清除联结";
    });
  };
  const search = document.getElementById("graphSearchInput");
  if (search) {
    var timer = null;
    search.oninput = function() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function() {
        if (window.Graph3D) window.Graph3D.filter(search.value.trim().toLowerCase());
      }, 200);
    };
  }
}
var _g3dTried = false;
async function ensureGraph3D() {
  if (window.Graph3D || _g3dTried) return !!window.Graph3D;
  _g3dTried = true;
  try {
    await import("/static/graph3d.js");
  } catch (e) { console.warn("3D graph module unavailable:", e); }
  return !!window.Graph3D;
}
function onGraphCardClick(card) {
  var id = card.card_id != null ? card.card_id : card.id;
  var full = cards.find(function(c) { return String(c.id) === String(id); });
  if (full) { openCardModal(full); return; }
  openCardModal({ id: id, title: card.title, scene_type: card.scene_type, source_date: card.source_date, tags: card.tags || [], summary: "", personal: "", image_url: "", recall_enabled: false, recall_count: 0, next_recall: "" });
}
async function loadGraph() {
  const wrap = document.getElementById("graphWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div class="graph-empty">加载记忆星图…</div>';
  try {
    const data = await api("/api/graph?limit=200");
    var has3d = await ensureGraph3D();
    var clearBtn = document.getElementById("clearConnBtn");
    if (clearBtn) clearBtn.style.display = (data.ai_links && data.ai_links.length) ? "" : "none";
    if (has3d && window.Graph3D.isReady) {
      window.Graph3D.render(wrap, data, onGraphCardClick, toggleConnectionLock);
    } else {
      renderGraph(wrap, data);
    }
  } catch (e) {
    if (window.Graph3D) window.Graph3D.dispose();
    wrap.innerHTML = '<div class="graph-empty">图谱加载失败：' + esc(e.message) + "</div>";
  }
}
function renderGraph(wrap, data) {
  const graphCards = data.cards || [];
  const tags = data.tags || [];
  const links = data.links || [];
  if (!graphCards.length) {
    wrap.innerHTML = '<div class="graph-empty">还没有足够卡片。先采集并补充标签，图谱会自动浮现联结。</div>';
    return;
  }
  const W = Math.max(wrap.clientWidth || 760, 420);
  const H = Math.max(wrap.clientHeight || 520, 360);
  const nodes = graphCards.map(c => ({ id: c.id, label: c.title, kind: "card", scene: c.scene_type, card: c }))
    .concat(tags.map(t => ({ id: t.id, label: t.name, kind: "tag", size: t.count || 1 })));
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  const N = nodes.length;
  nodes.forEach((n, i) => {
    n.x = W / 2 + Math.cos(2 * Math.PI * i / N) * W * 0.32;
    n.y = H / 2 + Math.sin(2 * Math.PI * i / N) * H * 0.32;
    n.vx = 0; n.vy = 0;
  });
  for (let it = 0; it < 80; it++) {
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = Math.min(90, 2600 / (d * d));
      dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const l of links) {
      const a = nodeMap[l.source], b = nodeMap[l.target];
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 70) * 0.006;
      dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.0012;
      n.vy += (H / 2 - n.y) * 0.0012;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(26, Math.min(W - 26, n.x));
      n.y = Math.max(22, Math.min(H - 22, n.y));
    }
  }
  const sceneColors = { enterprise: "#0F766E", museum: "#B45309", meeting: "#7C3AED", class: "#2563EB", travel: "#DB2777", custom: "#57534E" };
  let svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="记忆图谱">';
  for (const l of links) {
    const a = nodeMap[l.source], b = nodeMap[l.target];
    if (!a || !b) continue;
    svg += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="rgba(28,25,23,0.14)" stroke-width="1"/>';
  }
  var aiLinks = (data.ai_links || []);
  for (const al of aiLinks) {
    const a = nodeMap[al.source], b = nodeMap[al.target];
    if (!a || !b) continue;
    svg += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="' + (al.locked ? '#ffffff' : (al.reason ? '#22d3ee' : 'rgba(34,211,238,0.5)')) + '" stroke-width="1.8" stroke-dasharray="4 3" opacity="0.7"><title>' + esc(al.reason || 'AI connection') + (al.locked ? ' [\u5df2\u9501\u5b9a]' : '') + '</title></line>';
  }
  for (const n of nodes) {
    if (n.kind === "tag") {
      const r = Math.min(16, 7 + (n.size || 1) * 2.4);
      svg += '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="#FEF3C7" stroke="#B45309" stroke-width="1.2"/>';
      svg += '<text x="' + n.x.toFixed(1) + '" y="' + (n.y + r + 12).toFixed(1) + '" text-anchor="middle" font-size="11" fill="#92400E">' + esc(n.label) + "</text>";
    } else {
      const color = sceneColors[n.scene] || "#57534E";
      svg += '<g class="graph-card-node" data-id="' + escAttr(n.card.card_id) + '" style="cursor:pointer">';
      svg += '<rect x="' + (n.x - 58).toFixed(1) + '" y="' + (n.y - 15).toFixed(1) + '" width="116" height="30" rx="6" fill="#FFFFFF" stroke="' + color + '" stroke-width="1.4"/>';
      svg += '<text x="' + n.x.toFixed(1) + '" y="' + (n.y + 4).toFixed(1) + '" text-anchor="middle" font-size="10.5" fill="#1C1917">' + esc(truncateLabel(n.label, 14)) + "</text>";
      svg += "</g>";
    }
  }
  svg += "</svg>";
  wrap.innerHTML = svg;
  wrap.querySelectorAll(".graph-card-node").forEach(function(el) {
    el.onclick = function() {
      const id = el.dataset.id;
      const full = cards.find(function(c) { return String(c.id) === String(id); });
      if (full) { openCardModal(full); return; }
      const brief = graphCards.find(function(c) { return String(c.card_id) === String(id); });
      if (brief) {
        openCardModal({ id: brief.card_id, title: brief.title, scene_type: brief.scene_type, source_date: brief.source_date, tags: brief.tags || [], summary: "", personal: "", image_url: "", recall_enabled: false, recall_count: 0, next_recall: "" });
      }
    };
  });
  const legend = document.getElementById("graphLegend");
  if (legend) legend.innerHTML = "当前图谱：" + graphCards.length + " 张卡片 · " + tags.length + " 个标签 · " + links.length + " 条联结";
}
function truncateLabel(s, max) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---- Offline queue ----
function idbOpen() {
  return new Promise(function(resolve, reject) {
    const req = indexedDB.open("presence-offline", 1);
    req.onupgradeneeded = function() { req.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true }); };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}
function idbDone(req) {
  return new Promise(function(resolve, reject) {
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}
async function queueOfflineAnalyze(payload) {
  try {
    const db = await idbOpen();
    const tx = db.transaction("queue", "readwrite");
    await idbDone(tx.objectStore("queue").add(payload));
    db.close();
  } catch (e) {
    alert("离线暂存失败：" + e.message);
  }
}
async function offlineQueueItems() {
  const db = await idbOpen();
  const items = await idbDone(db.transaction("queue").objectStore("queue").getAll());
  db.close();
  return items || [];
}
async function offlineQueueDelete(id) {
  const db = await idbOpen();
  const tx = db.transaction("queue", "readwrite");
  await idbDone(tx.objectStore("queue").delete(id));
  db.close();
}
async function flushOfflineQueue() {
  if (!("indexedDB" in window)) return;
  let items;
  try { items = await offlineQueueItems(); } catch (e) { return; }
  if (!items.length) { renderOfflineStatus(); return; }
  renderOfflineStatus("正在同步 " + items.length + " 条离线采集…");
  for (const item of items) {
    const fd = new FormData();
    fd.append("scene_type", item.scene_type || "custom");
    fd.append("personalization", item.personalization || "");
    fd.append("notes", item.notes || "");
    (item.files || []).forEach(f => fd.append("files", f));
    try {
      const d = await api("/api/analyze", { method: "POST", body: fd });
      for (const c of (d.cards || [])) {
        await api("/api/cards/" + c.id + "/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      }
      await offlineQueueDelete(item.id);
    } catch (e) {
      renderOfflineStatus("同步失败：" + e.message);
      return;
    }
  }
  renderOfflineStatus();
  await loadCards(); await loadLedger(); await loadRecall();
}
function renderOfflineStatus(message) {
  const el = document.getElementById("offlineStatus");
  if (!el) return;
  if (message) {
    el.style.display = "flex";
    el.innerHTML = "<span>📡 " + esc(message) + "</span><button id='offlineFlushBtn'>立即同步</button>";
    const btn = document.getElementById("offlineFlushBtn");
    if (btn) btn.onclick = () => { btn.disabled = true; flushOfflineQueue().finally(() => { btn.disabled = false; }); };
  } else {
    el.style.display = "none";
  }
}
async function initOfflineQueue() {
  if (!("indexedDB" in window)) return;
  window.addEventListener("online", () => flushOfflineQueue());
  if (navigator.onLine) {
    try { await flushOfflineQueue(); } catch (e) {}
  }
}
