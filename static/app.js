// ===== 在场 — Frontend Logic =====
const API = "";
let scenarios = [];
let cards = [];
let selectedScenario = "enterprise";
let selectedFiles = [];
let currentFilter = "all";
let recallQueue = [];
let recallIndex = 0;

// ---- Init ----
document.addEventListener("DOMContentLoaded", async () => {
  await loadScenarios();
  await loadCards();
  await loadLedger();
  await loadRecall();
  setupTabs();
  setupUpload();
  setupAnalyze();
});

// ---- API helpers ----
async function api(path, opts = {}) {
  const r = await fetch(API + path, opts);
  if (!r.ok) throw new Error(path + " " + r.status);
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
    };
  });
}

// ---- Upload ----
function setupUpload() {
  const zone = document.getElementById("uploadZone");
  const input = document.getElementById("fileInput");
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add("dragover"); };
  zone.ondragleave = () => zone.classList.remove("dragover");
  zone.ondrop = e => {
    e.preventDefault(); zone.classList.remove("dragover");
    addFiles(e.dataTransfer.files);
  };
  input.onchange = () => addFiles(input.files);
}

function addFiles(fileList) {
  for (const f of fileList) selectedFiles.push(f);
  renderFileList();
}

function renderFileList() {
  const list = document.getElementById("fileList");
  list.innerHTML = selectedFiles.map((f, i) =>
    '<div class="file-item"><span>' + getFileIcon(f.type) + "</span><span>" + f.name +
    '</span><span class="file-remove" data-i="' + i + '">&times;</span></div>'
  ).join("");
  list.querySelectorAll(".file-remove").forEach(el => {
    el.onclick = () => { selectedFiles.splice(parseInt(el.dataset.i), 1); renderFileList(); };
  });
}

function getFileIcon(type) {
  if (type.startsWith("image/")) return "🖼";
  if (type.startsWith("audio/")) return "🎵";
  return "📄";
}

// ---- Analyze ----
function setupAnalyze() {
  document.getElementById("analyzeBtn").onclick = doAnalyze;
}

async function doAnalyze() {
  const btn = document.getElementById("analyzeBtn");
  const notes = document.getElementById("notesInput").value;
  const personalization = document.getElementById("personalizationInput").value;

  if (selectedFiles.length === 0 && !notes.trim()) {
    alert("请上传至少一个素材，或输入文字备注");
    return;
  }

  btn.disabled = true;
  btn.textContent = "AI 正在提炼…";

  const fd = new FormData();
  fd.append("scene_type", selectedScenario);
  fd.append("personalization", personalization);
  fd.append("notes", notes);
  for (const f of selectedFiles) fd.append("files", f);

  try {
    const data = await api("/api/analyze", { method: "POST", body: fd });
    renderDraftCards(data.cards, data.minutes_saved);
    selectedFiles = [];
    renderFileList();
    document.getElementById("notesInput").value = "";
    document.getElementById("personalizationInput").value = "";
  } catch (e) {
    alert("分析失败：" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "生成记忆卡片 →";
  }
}

function renderDraftCards(drafts, minutes) {
  const container = document.getElementById("draftCards");
  if (!drafts.length) {
    container.innerHTML = '<div class="draft-empty">AI 认为本次素材中没有值得长期保存的内容</div>';
    return;
  }
  let html = '<div style="font-size:13px;color:var(--ink-faint);margin-bottom:12px">AI 筛选出 ' + drafts.length + " 条值得留存的内容 · 预估节省 " + minutes + " 分钟整理时间</div>";
  html += drafts.map(c =>
    '<div class="draft-card" data-id="' + c.id + '">' +
    (c.image_url ? '<img style="width:100%;height:120px;object-fit:cover;border-radius:6px;margin-bottom:8px" src="' + c.image_url + '" alt="">' : "") + 
    '<div class="dc-title">' + esc(c.title) + "</div>" +
    '<div class="dc-summary">' + esc(c.summary) + "</div>" +
    '<div class="dc-personal">' + esc(c.personal) + "</div>" +
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
      await api("/api/cards/" + b.dataset.id + "/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      b.closest(".draft-card").style.opacity = "0.5";
      b.textContent = "已保存 ✓";
      b.disabled = true;
      await loadCards();
      await loadLedger();
      await loadRecall();
    };
  });
  container.querySelectorAll(".dc-btn.edit").forEach(b => {
    b.onclick = () => {
      const card = drafts.find(c => c.id == b.dataset.id);
      openEditModal(card);
    };
  });
  container.querySelectorAll(".dc-btn.skip").forEach(b => {
    b.onclick = async () => {
      await api("/api/cards/" + b.dataset.id, { method: "DELETE" });
      b.closest(".draft-card").remove();
    };
  });
  container.querySelectorAll(".recall-toggle").forEach(function(t) {
    t.classList.toggle("on", false);
    t.onclick = function(e) {
      e.stopPropagation();
      var on = !t.classList.contains("on");
      toggleRecall(t.dataset.id, on, t);
    };
  });
}

// ---- Library ----
async function loadCards() {
  const data = await api("/api/cards");
  cards = data.cards;
  renderFilters();
  renderLibrary();
}

function renderFilters() {
  const scenes = {};
  cards.forEach(c => { scenes[c.scene_type] = (scenes[c.scene_type] || 0) + 1; });
  const filters = document.getElementById("libraryFilters");
  let html = '<div class="filter-chip' + (currentFilter === "all" ? " active" : "") + '" data-f="all">全部 ' + cards.length + "</div>";
  for (const s of scenarios) {
    if (scenes[s.key]) {
      html += '<div class="filter-chip' + (currentFilter === s.key ? " active" : "") + '" data-f="' + s.key + '">' + s.name + " " + scenes[s.key] + "</div>";
    }
  }
  filters.innerHTML = html;
  filters.querySelectorAll(".filter-chip").forEach(el => {
    el.onclick = () => { currentFilter = el.dataset.f; renderFilters(); renderLibrary(); };
  });
}

function renderLibrary() {
  const grid = document.getElementById("cardGrid");
  const count = document.getElementById("libraryCount");
  const filtered = currentFilter === "all" ? cards : cards.filter(c => c.scene_type === currentFilter);
  count.textContent = filtered.length + " 张卡片";
  if (!filtered.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--ink-faint)">暂无记忆卡片</div>';
    return;
  }
  grid.innerHTML = filtered.map(c => {
    const sName = (scenarios.find(s => s.key === c.scene_type) || {}).name || c.scene_type;
    let img = "";
    if (c.image_url) img = '<img class="mem-card-img" src="' + c.image_url + '" alt="">';
    let recall = "";
    recall = '<span class="recall-toggle mem-recall-toggle ' + (c.recall_enabled ? "on" : "") + '" data-id="' + c.id + '"><span class="recall-switch"></span><span>' + (c.recall_enabled ? ("复习 " + (c.recall_count || 0)) : "开启回忆") + '</span></span>';
    return '<div class="mem-card" data-id="' + c.id + '">' +
      img +
      '<div class="mem-card-body">' +
      '<span class="mem-card-scene scene-' + c.scene_type + '">' + esc(sName) + "</span>" +
      '<div class="mem-card-title">' + esc(c.title) + "</div>" +
      '<div class="mem-card-summary">' + esc(c.summary) + "</div>" +
      (c.personal ? '<div class="mem-card-personal">' + esc(c.personal) + "</div>" : "") +
      '<div class="mem-card-tags">' + (c.tags || []).map(t => '<span class="mem-card-tag">' + esc(t) + "</span>").join("") + "</div>" +
      "</div>" +
      '<div class="mem-card-footer"><span>' + (c.source_date || "") + "</span>" + recall + "</div>" +
      "</div>";
  }).join("");
  grid.querySelectorAll(".mem-card").forEach(el => {
    el.onclick = () => {
      const card = cards.find(c => c.id == el.dataset.id);
      openCardModal(card);
    };
  });
  grid.querySelectorAll(".mem-recall-toggle").forEach(function(t) {
    t.onclick = function(e) {
      e.stopPropagation();
      var on = !t.classList.contains("on");
      toggleRecall(t.dataset.id, on, t);
    };
  });
}

// ---- Ledger ----
async function loadLedger() {
  const stats = await api("/api/ledger");
  const grid = document.getElementById("ledgerGrid");
  const sceneNames = {};
  scenarios.forEach(s => sceneNames[s.key] = s.name);
  const colors = { enterprise: "#0F766E", museum: "#B45309", meeting: "#7C3AED", class: "#2563EB", travel: "#DB2777", custom: "#525252" };

  let html = '<div class="ledger-stat"><div class="ledger-num">' + stats.total_cards + '</div><div class="ledger-label">记忆卡片总数</div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.total_minutes_saved + '<span class="unit"> min</span></div><div class="ledger-label">AI 替你整理的时间</div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.total_materials + '</div><div class="ledger-label">已处理素材数</div></div>';
  html += '<div class="ledger-stat"><div class="ledger-num">' + stats.recall_done + "/" + stats.recall_total + '</div><div class="ledger-label">回忆完成率</div></div>';

  const maxScene = Math.max(...Object.values(stats.by_scene), 1);
  html += '<div class="ledger-bar-section"><div class="ledger-bar-title">按场景分布</div>';
  for (const [key, count] of Object.entries(stats.by_scene)) {
    html += '<div class="bar-row"><div class="bar-label">' + esc(sceneNames[key] || key) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + (count / maxScene * 100) + "%;background:" + (colors[key] || "#525252") + '"></div></div>' +
      '<div class="bar-num">' + count + "</div></div>";
  }
  html += '<button class="btn-primary" style="margin-top:16px" onclick="closeModal();setTimeout(()=>openEditModal(' + card.id + '),200)">编辑卡片</button></div>";
  grid.innerHTML = html;
}

// ---- Recall ----
async function loadRecall() {
  const data = await api("/api/recall/due");
  recallQueue = data.cards;
  recallIndex = 0;
  const badge = document.getElementById("recallBadge");
  if (recallQueue.length > 0) badge.textContent = recallQueue.length;
  else badge.textContent = "";
  renderRecall();
}

function renderRecall() {
  const container = document.getElementById("recallContainer");
  if (!recallQueue.length) {
    container.innerHTML = '<div class="recall-empty"><p>🎉 暂无需要回忆的卡片</p><p style="margin-top:8px">所有复习都已完成，或当前场景未开启回忆功能</p></div>';
    return;
  }
  if (recallIndex >= recallQueue.length) {
    container.innerHTML = '<div class="recall-empty"><p>✅ 今天的回忆挑战已全部完成！</p><p style="margin-top:8px">明天再来巩固记忆吧</p></div>';
    return;
  }
  const card = recallQueue[recallIndex];
  const progress = recallIndex + 1;
  container.innerHTML =
    '<div class="recall-intro">第 ' + progress + " / " + recallQueue.length + ' 张 · 基于间隔重复算法，在遗忘临界点主动发起回忆</div>' +
    '<div class="recall-card">' +
    '<div class="recall-prompt-label">回忆提示</div>' +
    '<div class="recall-hint">' + getRecallHint(card) + "</div>" +
    '<div class="recall-prompt-label">试着回忆（可选）</div>' +
    '<textarea class="recall-try" id="recallTry" placeholder="先在脑海里回忆一下，再点击揭晓答案…" rows="3"></textarea>' +
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

  document.getElementById("revealBtn").onclick = () => {
    document.getElementById("recallReveal").classList.add("show");
    document.getElementById("revealBtn").style.display = "none";
  };
  container.querySelectorAll(".recall-diff-btn").forEach(b => {
    b.onclick = async () => {
      await api("/api/recall/" + card.id + "/attempt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty: parseInt(b.dataset.d) })
      });
      recallIndex++;
      renderRecall();
      await loadCards();
      await loadLedger();
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
  if (card.image_url) html += '<img src="' + card.image_url + '" alt="">';
  html += '<div class="modal-title">' + esc(card.title) + "</div>";
  html += '<div class="modal-section"><div class="modal-section-label">客观总结</div><div class="modal-section-text">' + esc(card.summary) + "</div></div>";
  html += '<div class="modal-section"><div class="modal-section-label">个人归因</div><div class="modal-section-text" style="color:var(--amber);font-style:italic">' + esc(card.personal) + "</div></div>";
  if (card.tags && card.tags.length) {
    html += '<div class="modal-section"><div class="modal-section-label">标签</div><div class="mem-card-tags">' + card.tags.map(t => '<span class="mem-card-tag">' + esc(t) + "</span>").join("") + "</div></div>";
  }
  html += '<div class="modal-section"><div class="modal-section-label">日期</div><div class="modal-section-text">' + (card.source_date || "") + "</div></div>";
  if (card.recall_enabled) {
    html += '<div class="modal-section"><div class="modal-section-label">复习状态</div><div class="modal-section-text">已复习 ' + (card.recall_count || 0) + " 次 · 下次复习：" + (card.next_recall || "待定") + "</div></div>";
  }
  html += '<button class="btn-primary" style="margin-top:16px" onclick="closeModal();setTimeout(()=>openEditModal(' + card.id + '),200)">编辑卡片</button></div>";
  body.innerHTML = html;
  document.getElementById("cardModal").classList.add("show");
}

function openEditModal(card) {
  const body = document.getElementById("modalBody");
  body.innerHTML =
    '<div class="modal-body">' +
    '<div class="modal-title">编辑记忆卡片</div>' +
    '<div class="modal-section"><div class="modal-section-label">标题</div>' +
    '<input class="personalization-input" id="editTitle" value="' + escAttr(card.title) + '"></div>' +
    '<div class="modal-section"><div class="modal-section-label">客观总结</div>' +
    '<textarea class="notes-input" id="editSummary" rows="3">' + escAttr(card.summary) + "</textarea></div>" +
    '<div class="modal-section"><div class="modal-section-label">个人归因</div>' +
    '<textarea class="notes-input" id="editPersonal" rows="2">' + escAttr(card.personal) + "</textarea></div>" +
    '<div class="modal-section"><div class="modal-section-label">标签</div>' +
    '<input class="personalization-input" id="editTags" value="' + escAttr((card.tags || []).join(", ")) + '" placeholder="多个标签用逗号分隔">' +
    '</div>' +
    '<div class="modal-section"><div class="modal-section-label">回忆</div>' +
    '<span class="recall-toggle ' + (card.recall_enabled ? "on" : "") + '" id="editRecallToggle"><span class="recall-switch"></span><span>' + (card.recall_enabled ? '已开启' : '点击开启') + '</span></span></div>' +
    '<button class="btn-primary" id="saveEdit">保存</button>' +
    "</div>";
  document.getElementById("cardModal").classList.add("show");
  var editToggle = document.getElementById("editRecallToggle");
  if (editToggle) {
    editToggle.onclick = function() {
      var on = !editToggle.classList.contains("on");
      editToggle.classList.toggle("on", on);
      editToggle.querySelector("span:last-child").textContent = on ? "已开启" : "点击开启";
    };
  }
  document.getElementById("saveEdit").onclick = async () => {
    await api("/api/cards/" + card.id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recall_enabled: !!document.getElementById("editRecallToggle") && document.getElementById("editRecallToggle").classList.contains("on"),
        title: document.getElementById("editTitle").value,
        summary: document.getElementById("editSummary").value,
        personal: document.getElementById("editPersonal").value,
        tags: (document.getElementById("editTags").value || "").split(",").map(t => t.trim()).filter(t => t),
        status: "confirmed"
      })
    });
    closeModal();
    await loadCards();
    const drafts = Array.from(document.querySelectorAll(".draft-card")).map(el => el.dataset.id);
    if (drafts.includes(String(card.id))) {
      const el = document.querySelector('.draft-card[data-id="' + card.id + '"]');
      if (el) el.remove();
    }
  };
}

function closeModal() {
  document.getElementById("cardModal").classList.remove("show");
}
document.getElementById("cardModal").onclick = e => { if (e.target.id === "cardModal") closeModal(); };

// ---- Utils ----
function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u200b-\u200f\u2028-\u202e\u00a0\u3000\ufeff]/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
function escAttr(s) {
  if (!s) return "";
  return esc(s);
}

// ---- recall toggle (per-card, user choice) ----
async function toggleRecall(cardId, on, el) {
  await api("/api/cards/" + cardId, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recall_enabled: on })
  });
  if (el) {
    el.classList.toggle("on", on);
    var label = el.querySelector("span:last-child");
    if (label) label.textContent = on ? "已开启回忆" : "开启回忆";
  }
  await loadCards();
  await loadLedger();
  await loadRecall();
}
