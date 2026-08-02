// graph3d.js - 3D memory galaxy (Three.js ES module)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

(function () {
  var SCENE_COLORS = {
    enterprise: 0x60a5fa, museum: 0xfbbf24, meeting: 0xa78bfa,
    class: 0x34d399, travel: 0xf472b6, custom: 0xfb923c
  };
  var SCENE_NAMES = {
    enterprise: "\u4f01\u4e1a\u53c2\u8bbf", museum: "\u5c55\u89c8\u9986",
    meeting: "\u4f1a\u8bae", class: "\u8bfe\u7a0b", travel: "\u65c5\u884c", custom: "\u81ea\u5b9a\u4e49"
  };
  var state = null;

  function dispose() {
    if (!state) return;
    if (state.animId) cancelAnimationFrame(state.animId);
    if (state.tooltip) state.tooltip.remove();
    if (state.clusterLabels) state.clusterLabels.forEach(function (l) { l.el.remove(); });
      if (state.renderer) {
      state.renderer.dispose();
      var el = state.renderer.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    if (state.controls) state.controls.dispose();
    state = null;
  }

  function makeStarTexture(coreAlpha) {
    coreAlpha = coreAlpha || 1;
    var c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,' + coreAlpha + ')');
    g.addColorStop(0.08, 'rgba(255,255,255,' + (coreAlpha * 0.85) + ')');
    g.addColorStop(0.3, 'rgba(255,255,255,' + (coreAlpha * 0.25) + ')');
    g.addColorStop(0.7, 'rgba(255,255,255,' + (coreAlpha * 0.04) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  function makeGlowTexture() {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.1, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  function makeNebulaTexture(hue) {
    var c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    var ctx = c.getContext('2d');
    for (var i = 0; i < 14; i++) {
      var x = 64 + Math.random() * 128;
      var y = 64 + Math.random() * 128;
      var r = 30 + Math.random() * 70;
      var a = 0.015 + Math.random() * 0.04;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'hsla(' + hue + ',75%,65%,' + a + ')');
      g.addColorStop(1, 'hsla(' + hue + ',75%,65%,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    return new THREE.CanvasTexture(c);
  }

  function escH(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render(container, data, onCardClick, onToggleLock) {
    dispose();
    var cards = (data.cards || []).slice();
    var links = data.links || [];
    var aiLinks = data.ai_links || [];
    if (!cards.length) {
      container.innerHTML = '<div class="graph-empty">\u8fd8\u6ca1\u6709\u8db3\u591f\u5361\u7247\u3002\u5148\u91c7\u96c6\u5e76\u8865\u5145\u6807\u7b7e\uff0c\u56fe\u8c31\u4f1a\u81ea\u52a8\u6d6e\u73b0\u8054\u7ed3\u3002</div>';
      return;
    }
    try {
      _build(container, cards, links, onCardClick, aiLinks, onToggleLock);
    } catch (e) {
      console.warn('3D graph build failed:', e);
      container.innerHTML = '<div class="graph-empty">3D \u56fe\u8c31\u521d\u59cb\u5316\u5931\u8d25\uff1a' + escH(e.message) + '</div>';
    }
  }

  function _build(container, cards, links, onCardClick, aiLinks, onToggleLock) {
    container.innerHTML = '';
    container.style.position = 'relative';
    var W = Math.max(container.clientWidth || 760, 320);
    var H = Math.max(container.clientHeight || 520, 360);

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05050f, 0.0006);
    scene.background = new THREE.Color(0x05050f);

    var camera = new THREE.PerspectiveCamera(55, W / H, 1, 5000);
    camera.position.set(0, 60, 340);

    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.cursor = 'grab';

    var controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 30;
    controls.maxDistance = 1200;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.25;
    controls.addEventListener('start', function () { controls.autoRotate = false; });

    var starTex = makeStarTexture(1);
    var glowTex = makeGlowTexture();

    // ---- Deep starfield: 3 layers ----
    var layers = [
      { count: 4000, minR: 600, maxR: 1600, minSize: 0.6, maxSize: 1.2, opacity: 0.5 },
      { count: 2000, minR: 300, maxR: 600, minSize: 0.8, maxSize: 1.6, opacity: 0.7 },
      { count: 800, minR: 100, maxR: 300, minSize: 1.0, maxSize: 2.5, opacity: 0.85 }
    ];
    layers.forEach(function (ly) {
      var pos = new Float32Array(ly.count * 3);
      var col = new Float32Array(ly.count * 3);
      for (var i = 0; i < ly.count; i++) {
        var r = ly.minR + Math.random() * (ly.maxR - ly.minR);
        var th = Math.random() * Math.PI * 2;
        var ph = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
        pos[i*3+1] = r * Math.sin(ph) * Math.sin(th) * 0.6;
        pos[i*3+2] = r * Math.cos(ph);
        // Stellar color spectrum: blue-white, white, yellow-white, orange-red
        var t = Math.random();
        var cr, cg, cb;
        if (t < 0.35) { cr = 0.7; cg = 0.8; cb = 1.0; }        // blue-white
        else if (t < 0.65) { cr = 1.0; cg = 1.0; cb = 1.0; }     // white
        else if (t < 0.85) { cr = 1.0; cg = 0.95; cb = 0.75; }   // yellow-white
        else { cr = 1.0; cg = 0.7; cb = 0.5; }                   // orange
        var b = 0.3 + Math.random() * 0.7;
        col[i*3] = cr * b; col[i*3+1] = cg * b; col[i*3+2] = cb * b;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var mat = new THREE.PointsMaterial({
        size: ly.minSize + (ly.maxSize - ly.minSize) * 0.5,
        map: starTex, vertexColors: true, transparent: true,
        opacity: ly.opacity, blending: THREE.AdditiveBlending,
        sizeAttenuation: true, depthWrite: false
      });
      scene.add(new THREE.Points(geo, mat));
    });

    // ---- Nebula clouds ----
    var nebulaHues = [200, 280, 340, 30, 180];
    nebulaHues.forEach(function (hue, idx) {
      var ang = (idx / nebulaHues.length) * Math.PI * 2;
      var dist = 400 + Math.random() * 400;
      var tex = makeNebulaTexture(hue);
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sp.position.set(Math.cos(ang) * dist, (Math.random() - 0.5) * 200, Math.sin(ang) * dist);
      sp.scale.set(500 + Math.random() * 300, 500 + Math.random() * 300, 1);
      scene.add(sp);
    });

    // ---- Cluster centers ----
    var stypes = [], seen = {};
    cards.forEach(function (c) { if (!seen[c.scene_type]) { seen[c.scene_type] = 1; stypes.push(c.scene_type); } });
    var centers = {};
    stypes.forEach(function (st, idx) {
      var ang = (idx / Math.max(stypes.length, 1)) * Math.PI * 2;
      var rad = 70 + stypes.length * 8;
      centers[st] = new THREE.Vector3(Math.cos(ang) * rad, (idx % 2 ? 1 : -1) * (10 + idx * 6), Math.sin(ang) * rad);
    });

    // ---- Cluster halos ----
    Object.keys(centers).forEach(function (st) {
      var color = SCENE_COLORS[st] || SCENE_COLORS.custom;
      var halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: color, transparent: true, opacity: 0.04,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.position.copy(centers[st]);
      halo.scale.set(120, 120, 1);
      scene.add(halo);
    });

    // ---- Card stars ----
    var cardGeo = new THREE.SphereGeometry(1.6, 12, 12);
    var meshes = [], byId = {};
    cards.forEach(function (card) {
      var ctr = centers[card.scene_type] || new THREE.Vector3();
      var a = Math.random() * Math.PI * 2, rr = Math.random() * 40;
      var pos = new THREE.Vector3(
        ctr.x + Math.cos(a) * rr + (Math.random() - 0.5) * 12,
        ctr.y + (Math.random() - 0.5) * 36,
        ctr.z + Math.sin(a) * rr + (Math.random() - 0.5) * 12
      );
      var color = SCENE_COLORS[card.scene_type] || SCENE_COLORS.custom;
      var mesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ color: color }));
      mesh.position.copy(pos);
      mesh.userData = { card: card, phase: Math.random() * 6.28, color: color };
      // Inner glow
      var ig = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: color, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      ig.scale.set(10, 10, 1);
      mesh.add(ig);
      mesh.userData.innerGlow = ig;
      // Outer corona
      var og = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: color, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      og.scale.set(24, 24, 1);
      mesh.add(og);
      mesh.userData.outerGlow = og;
      scene.add(mesh);
      meshes.push(mesh);
      byId[String(card.card_id != null ? card.card_id : card.id)] = card;
      card._p = pos.clone();
    });

    // ---- Connection lines ----
    // Shared-tag links: cards with matching tags get connected (rose)
    var sharedLP = [];
    var seenPairs = {};
    var tagToCards = {};
    cards.forEach(function (card) {
      var cid = String(card.card_id != null ? card.card_id : card.id);
      (card.tags || []).forEach(function (tag) {
        if (!tagToCards[tag]) tagToCards[tag] = [];
        tagToCards[tag].push(cid);
      });
    });
    Object.keys(tagToCards).forEach(function (tag) {
      var group = tagToCards[tag];
      for (var i = 0; i < group.length; i++) {
        for (var j = i + 1; j < group.length; j++) {
          var pk = group[i] < group[j] ? group[i] + "|" + group[j] : group[j] + "|" + group[i];
          if (seenPairs[pk]) continue;
          seenPairs[pk] = 1;
          var a = byId[group[i]], b = byId[group[j]];
          if (a && b && a._p && b._p)
            sharedLP.push(a._p.x, a._p.y, a._p.z, b._p.x, b._p.y, b._p.z);
        }
      }
    });


    var tagLines = [];
    if (sharedLP.length) {
      var sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sharedLP, 3));
      scene.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({
        color: 0xf43f5e, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false
      })));
    }
    // ---- AI-discovered connections (dashed-looking lines, hover for reason) ----
    var aiLines = [];
    if (aiLinks && aiLinks.length) {
      aiLinks.forEach(function(al) {
        var idA = String(al.source || '').replace('card-', '');
        var idB = String(al.target || '').replace('card-', '');
        var cardA = byId[idA], cardB = byId[idB];
        if (!cardA || !cardB || !cardA._p || !cardB._p) return;
        var lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute([
          cardA._p.x, cardA._p.y, cardA._p.z, cardB._p.x, cardB._p.y, cardB._p.z
        ], 3));
        var lm = new THREE.LineBasicMaterial({
          color: 0x22d3ee, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        var line = new THREE.Line(lg, lm);
        var locked = !!al.locked;
        line.userData = {
          ai: true, reason: al.reason || '',
          pa: cardA._p.clone(), pb: cardB._p.clone(),
          titleA: cardA.title || '', titleB: cardB.title || '',
          locked: locked,
          cardA: parseInt(idA, 10) || 0,
          cardB: parseInt(idB, 10) || 0
        };
        line.material.color.setHex(locked ? 0xffffff : 0x22d3ee);
        line.material.opacity = locked ? 0.9 : 0.5;
        scene.add(line);
        aiLines.push(line);
      });
    }
    // Also create individual pickable line objects with tag metadata for hover tooltips
    Object.keys(tagToCards).forEach(function (tag) {
      var group = tagToCards[tag];
      if (group.length < 2) return;
      for (var i = 0; i < group.length; i++) {
        for (var j = i + 1; j < group.length; j++) {
          var a = byId[group[i]], b = byId[group[j]];
          if (!a || !b || !a._p || !b._p) continue;
          var lg = new THREE.BufferGeometry();
          lg.setAttribute('position', new THREE.Float32BufferAttribute([
            a._p.x, a._p.y, a._p.z, b._p.x, b._p.y, b._p.z
          ], 3));
          var lm = new THREE.LineBasicMaterial({
            color: 0xf43f5e, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false
          });
          var line = new THREE.Line(lg, lm);
          line.userData = { tag: tag, cardA: group[i], cardB: group[j], pa: a._p.clone(), pb: b._p.clone() };
          scene.add(line);
          tagLines.push(line);
        }
      }
    });
    // ---- Cluster labels ----
    var cLabels = [];
    Object.keys(centers).forEach(function (st) {
      var el = document.createElement('div');
      el.textContent = SCENE_NAMES[st] || st;
      el.style.cssText = 'position:absolute;pointer-events:none;transform:translate(-50%,-50%);' +
        'font-size:14px;font-weight:700;letter-spacing:4px;color:rgba(255,255,255,0.42);' +
        'text-shadow:0 0 20px rgba(255,255,255,0.35),0 0 6px rgba(0,0,0,0.8);white-space:nowrap;z-index:1;';
      container.appendChild(el);
      cLabels.push({ el: el, pos: centers[st] });
    });

    // ---- Tooltip ----
    var tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:10;' +
      'background:rgba(8,10,28,0.94);border:1px solid rgba(255,255,255,0.1);border-radius:10px;' +
      'padding:10px 14px;font-size:13px;color:#e2e8f0;max-width:280px;line-height:1.6;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 24px rgba(99,102,241,0.08);' +
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);';
    container.appendChild(tip);

    // ---- Raycasting ----
    var ray = new THREE.Raycaster();
    var mouse = new THREE.Vector2(-999, -999);
    var hov = null;
    var pointerDown = null;
    renderer.domElement.addEventListener('pointerdown', function (e) { pointerDown = { x: e.clientX, y: e.clientY }; });
    renderer.domElement.addEventListener('pointermove', function (e) {
      var rc = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rc.left) / rc.width) * 2 - 1;
      mouse.y = -((e.clientY - rc.top) / rc.height) * 2 + 1;
    });
    renderer.domElement.addEventListener('pointerleave', function () { mouse.x = -999; mouse.y = -999; });
    renderer.domElement.addEventListener('click', function (e) {
      if (pointerDown && (Math.abs(e.clientX - pointerDown.x) > 5 || Math.abs(e.clientY - pointerDown.y) > 5)) return;
      if (hov && onCardClick) { e.stopPropagation(); onCardClick(hov.userData.card); return; }
      if (state.hovAiLine && onToggleLock) {
        e.stopPropagation();
        var ud = state.hovAiLine.userData;
        onToggleLock(ud.cardA, ud.cardB).then(function(locked) {
          ud.locked = locked;
          state.hovAiLine.material.color.setHex(locked ? 0xffffff : 0x22d3ee);
          state.hovAiLine.material.opacity = locked ? 0.9 : 0.5;
        });
      }
    });

    function project(p) {
      var v = p.clone().project(camera);
      var w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      return { x: (v.x + 1) / 2 * w, y: (-v.y + 1) / 2 * h };
    }

    var clock = new THREE.Clock();
    function animate() {
      state.animId = requestAnimationFrame(animate);
      var t = clock.getElapsedTime();
      controls.update();
      ray.setFromCamera(mouse, camera);
      ray.params.Points.threshold = 3;
      var hits = ray.intersectObjects(meshes, false);
      var nh = hits.length > 0 ? hits[0].object : null;
      // Screen-space line picking: find the line whose projected image
      // is visually closest to the mouse cursor (not 3D ray distance).
      var mx = mouse.x, my = mouse.y;
      function pickLine(arr) {
        if (!arr.length || mx < -1) return null;
        var rc = renderer.domElement.getBoundingClientRect();
        var mpx = ((mx + 1) / 2) * rc.width;
        var mpy = ((1 - my) / 2) * rc.height;
        var best = null, bestDist = 15;
        for (var i = 0; i < arr.length; i++) {
          var L = arr[i];
          var ud = L.userData;
          if (!ud || !ud.pa || !ud.pb) continue;
          var va = ud.pa.clone().project(camera);
          var vb = ud.pb.clone().project(camera);
          if (va.z > 1 && vb.z > 1) continue;
          var ax = (va.x + 1) / 2 * rc.width, ay = (1 - va.y) / 2 * rc.height;
          var bx = (vb.x + 1) / 2 * rc.width, by = (1 - vb.y) / 2 * rc.height;
          var dx = bx - ax, dy = by - ay;
          var len2 = dx * dx + dy * dy;
          var t = 0;
          if (len2 > 0.01) {
            t = ((mpx - ax) * dx + (mpy - ay) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
          }
          var px = ax + t * dx, py = ay + t * dy;
          var ddx = mpx - px, ddy = mpy - py;
          var dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < bestDist) { bestDist = dist; best = L; }
        }
        return best;
      }
      var nl = pickLine(tagLines);
      var nai = pickLine(aiLines);
      if (nh !== hov) {
        if (hov) {
          hov.userData.innerGlow.material.opacity = 0.5;
          hov.userData.outerGlow.material.opacity = 0.15;
          hov.scale.setScalar(1);
        }
        hov = nh;
        if (hov) {
          hov.userData.innerGlow.material.opacity = 0.95;
          hov.userData.outerGlow.material.opacity = 0.4;
          hov.scale.setScalar(1.8);
          renderer.domElement.style.cursor = 'pointer';
        } else if (!nl && !nai) { renderer.domElement.style.cursor = 'grab'; }
      }
      // Tag line hover: brighten line + show tag tooltip
      if (nl !== state.hovLine) {
        if (state.hovLine) state.hovLine.material.opacity = 0;
        state.hovLine = nl;
        if (nl) {
          nl.material.opacity = 0.9;
          nl.material.color.setHex(0xfb7185);
          renderer.domElement.style.cursor = 'pointer';
        }
      }
      // AI line hover: brighten line
      if (nai !== state.hovAiLine) {
        if (state.hovAiLine) {
          var oud = state.hovAiLine.userData;
          state.hovAiLine.material.color.setHex(oud.locked ? 0xffffff : 0x22d3ee);
          state.hovAiLine.material.opacity = oud.locked ? 0.9 : 0.5;
        }
        state.hovAiLine = nai;
        if (nai) {
          nai.material.opacity = 1;
          nai.material.color.setHex(0x7dd3fc);
          renderer.domElement.style.cursor = 'pointer';
        }
      }
      // Gentle pulse on non-hovered AI lines to invite interaction
      var aiPulse = 0.35 + Math.sin(t * 1.4) * 0.15;
      var lockPulse = 0.7 + Math.sin(t * 1.0) * 0.1;
      for (var ai = 0; ai < aiLines.length; ai++) {
        var aL = aiLines[ai];
        if (aL === state.hovAiLine) continue;
        aL.material.opacity = aL.userData.locked ? lockPulse : aiPulse;
      }
      var fq = state.filterQuery;
      for (var k = 0; k < meshes.length; k++) {
        var m = meshes[k];
        if (m === hov) continue;
        var pulse = 0.35 + Math.sin(t * 1.2 + m.userData.phase) * 0.18;
        var card = m.userData.card;
        if (fq) {
          var title = (card.title || "").toLowerCase();
          var tags = (card.tags || []).map(function(t) { return t.toLowerCase(); });
          var matched = title.indexOf(fq) >= 0 || tags.some(function(t) { return t.indexOf(fq) >= 0; });
          if (matched) {
            m.userData.innerGlow.material.opacity = 0.95;
            m.userData.outerGlow.material.opacity = 0.4 + Math.sin(t * 2.5 + m.userData.phase) * 0.2;
            m.scale.setScalar(2);
          } else {
            m.userData.innerGlow.material.opacity = 0.12;
            m.userData.outerGlow.material.opacity = 0.03;
            m.scale.setScalar(0.6);
          }
        } else {
          m.userData.innerGlow.material.opacity = pulse;
          m.userData.outerGlow.material.opacity = 0.08 + Math.sin(t * 0.8 + m.userData.phase) * 0.06;
          m.scale.setScalar(1);
        }
      }
      if (hov) {
        var p = project(hov.position);
        tip.style.display = 'block';
        tip.style.left = Math.min(p.x + 18, renderer.domElement.clientWidth - 280) + 'px';
        tip.style.top = Math.max(p.y - 20, 0) + 'px';
        var c = hov.userData.card;
        var hex = '#' + hov.userData.color.toString(16).padStart(6, '0');
        var th2 = '';
        if (c.tags && c.tags.length) {
          th2 = '<div style="font-size:11px;color:#94a3b8;margin-top:4px">' +
            c.tags.map(function (tg) { return '#' + escH(tg); }).join(' ') + '</div>';
        }
        tip.innerHTML = '<div style="font-weight:600;margin-bottom:2px;color:#f1f5f9">' + escH(c.title) + '</div>' +
          '<div style="font-size:11px;color:' + hex + '">' + (SCENE_NAMES[c.scene_type] || c.scene_type) + '</div>' + th2;
      } else if (state.hovLine) {
        var mp = state.hovLine.userData.pa.clone().lerp(state.hovLine.userData.pb, 0.5);
        var pp = project(mp);
        tip.style.display = 'block';
        tip.style.left = Math.min(pp.x + 18, renderer.domElement.clientWidth - 200) + 'px';
        tip.style.top = Math.max(pp.y - 20, 0) + 'px';
        tip.innerHTML = '<div style="font-weight:600;color:#f43f5e">#' + escH(state.hovLine.userData.tag) + '</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:2px">\u5171\u4eab\u6807\u7b7e\u8054\u7ed3</div>';
      } else if (state.hovAiLine) {
        var am = state.hovAiLine.userData.pa.clone().lerp(state.hovAiLine.userData.pb, 0.5);
        var ap = project(am);
        tip.style.display = 'block';
        tip.style.left = Math.min(ap.x + 18, renderer.domElement.clientWidth - 280) + 'px';
        tip.style.top = Math.max(ap.y - 20, 0) + 'px';
        var ud2 = state.hovAiLine.userData;
        var lockBadge = ud2.locked
          ? '<span style="color:#ffffff">\uD83D\uDD12 \u5df2\u9501\u5b9a</span>'
          : '<span style="color:#64748b">\uD83D\uDD13 \u70b9\u51fb\u9501\u5b9a</span>';
        tip.innerHTML = '<div style="font-weight:600;color:' + (ud2.locked ? '#ffffff' : '#22d3ee') + '">\uD83E\uDDE0 AI \u53d1\u73b0\u7684\u8054\u7ed3 ' + lockBadge + '</div>' +
          '<div style="font-size:12px;color:#e2e8f0;margin-top:4px;line-height:1.6">' + escH(ud2.reason) + '</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08)">' +
          escH(ud2.titleA) + ' \u2194 ' + escH(ud2.titleB) + '</div>';
      } else { tip.style.display = 'none'; }
      for (var ci = 0; ci < cLabels.length; ci++) {
        var cp = project(cLabels[ci].pos);
        cLabels[ci].el.style.left = cp.x + 'px';
        cLabels[ci].el.style.top = cp.y + 'px';
        var d = camera.position.distanceTo(cLabels[ci].pos);
        cLabels[ci].el.style.opacity = Math.max(0.06, Math.min(0.4, 200 / d));
      }
      renderer.render(scene, camera);
    }

    function onResize() {
      var w = Math.max(container.clientWidth, 320);
      var h = Math.max(container.clientHeight || 520, 360);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    state = { renderer: renderer, controls: controls, tooltip: tip, clusterLabels: cLabels, animId: null, onResize: onResize, meshes: meshes, filterQuery: '', hovLine: null, hovAiLine: null };
    animate();
  }

  function filter(query) {
    if (!state) return;
    state.filterQuery = query || "";
  }

  window.Graph3D = { render: render, dispose: dispose, isReady: true, filter: filter };
  window.dispatchEvent(new Event('graph3d-ready'));
})();
