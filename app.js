/* 5H13studio — 1:1 product photo studio */
(() => {
  'use strict';

  const APP_VERSION = '1.8.0';
  const SIZE = 1080;          // output square
  const MAX_DIM = 1200;       // working resolution for photos (keeps phones fast)
  const UNDO_LIMIT = 6;
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  const $ = (id) => document.getElementById(id);
  const canvas = $('studio-canvas');
  const ctx = canvas.getContext('2d');

  // ---------- Safe storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    }
  };

  // ---------- roundRect fallback (older Safari) ----------
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }

  // ---------- State ----------
  const saved = store.get('5h13.settings', {});
  const S = {
    raw: null, rawData: null,                 // original pixels at working size
    work: null, wctx: null,                   // edited cutout
    bbox: null,                               // visible subject bounds in work coords
    x: SIZE / 2, y: SIZE / 2, scale: 1, rot: 0,
    brightness: 0, contrast: 0, saturation: 0, exposure: 0,
    crop: { x: 0, y: 0, w: 100, h: 100 },
    tool: 'move', brush: 28, tol: 35, lastOpAuto: false,
    undo: [],
    autoStrip: saved.autoStrip ?? true,
    showBadge: saved.showBadge ?? true,
    title: '', subtitle: '',
    badgeStyle: saved.badgeStyle || 'minimal-pill',
    font: saved.font || 'Bricolage Grotesque',
    backdrop: saved.backdrop || 'white',
    customBg: saved.customBg || '#f1f5f9',
    shadow: saved.shadow ?? true,
    stamp: saved.stamp ?? false,
    stampPos: saved.stampPos || 'br',
    stores: store.get('5h13.stores', null) || [1, 2, 3].map(n => ({ name: `Store ${n}`, logo: null, pos: 'tr', size: 18, opacity: 100 })),
    activeStore: store.get('5h13.activeStore', -1),
    editStore: 0,
    logoImgs: [null, null, null],
    cam: { stream: null, facing: 'environment', torch: false, mode: 'product' },
    installPrompt: null
  };
  if (S.activeStore >= 0) S.editStore = S.activeStore;

  const saveSettings = () => store.set('5h13.settings', {
    autoStrip: S.autoStrip, showBadge: S.showBadge, badgeStyle: S.badgeStyle, font: S.font,
    backdrop: S.backdrop, customBg: S.customBg, shadow: S.shadow, stamp: S.stamp, stampPos: S.stampPos
  });

  // ---------- UI helpers ----------
  const haptic = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    $('toast-text').textContent = msg;
    t.classList.remove('-translate-y-32', 'opacity-0');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('-translate-y-32', 'opacity-0'), Math.max(2400, msg.length * 60));
  }
  function loading(text) {
    const l = $('loader');
    if (text) { $('loader-text').textContent = text; l.classList.remove('hidden'); l.classList.add('flex'); }
    else { l.classList.add('hidden'); l.classList.remove('flex'); }
  }
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

  // =====================================================================
  //  IMAGE LOADING
  // =====================================================================
  function loadImageFromURL(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode'));
      img.src = src;
    });
  }

  function setImage(source) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const k = Math.min(1, MAX_DIM / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));

    const raw = document.createElement('canvas');
    raw.width = w; raw.height = h;
    const rctx = raw.getContext('2d', { willReadFrequently: true });
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(source, 0, 0, w, h);
    S.raw = raw;
    S.rawData = rctx.getImageData(0, 0, w, h);

    S.work = document.createElement('canvas');
    S.work.width = w; S.work.height = h;
    S.wctx = S.work.getContext('2d', { willReadFrequently: true });
    S.wctx.putImageData(S.rawData, 0, 0);
    S.undo = []; updateUndo();
    S.lastOpAuto = false;
    S.brightness = S.contrast = S.saturation = S.exposure = 0;
    S.crop = { x: 0, y: 0, w: 100, h: 100 };
    syncPhotoAdjustUI?.();
    computeBBox();
    $('empty-state').classList.add('hidden');
    $('empty-state').classList.remove('flex');
    fitSubject();
  }

  async function handleFile(file) {
    if (!file) return;
    loading('Opening photo…');
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImageFromURL(url);
      setImage(img);
      closeCamera();
      setTab(null);
      await afterNewPhoto();
    } catch {
      toast(/hei[cf]/i.test(file.type + file.name) ? 'HEIC not supported here — pick a JPG' : 'Could not open that image');
    } finally {
      URL.revokeObjectURL(url);
      loading(null);
    }
  }

  async function afterNewPhoto() {
    if (S.autoStrip) await aiRemoveBackground(true);
    else render();
  }

  // ---------- Demo products ----------
  function demoCanvas(type) {
    const c = document.createElement('canvas');
    c.width = c.height = 1000;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, 1000);
    bg.addColorStop(0, '#f1f5f9'); bg.addColorStop(1, '#e8edf3');
    g.fillStyle = bg; g.fillRect(0, 0, 1000, 1000);
    g.textAlign = 'center';
    if (type === 'perfume') {
      const cap = g.createLinearGradient(435, 0, 565, 0);
      cap.addColorStop(0, '#b45309'); cap.addColorStop(0.5, '#fde68a'); cap.addColorStop(1, '#92400e');
      g.fillStyle = cap; g.beginPath(); g.roundRect(435, 180, 130, 90, 10); g.fill();
      g.fillStyle = '#cbd5e1'; g.fillRect(470, 268, 60, 36);
      const glass = g.createLinearGradient(330, 300, 670, 800);
      glass.addColorStop(0, '#22d3ee'); glass.addColorStop(0.55, '#0284c7'); glass.addColorStop(1, '#0c4a6e');
      g.fillStyle = glass; g.beginPath(); g.roundRect(330, 300, 340, 500, 44); g.fill();
      g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.roundRect(352, 330, 26, 420, 13); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.roundRect(385, 470, 230, 170, 12); g.fill();
      g.fillStyle = '#0f172a'; g.font = '800 30px "Bricolage Grotesque"'; g.fillText('AURA', 500, 528);
      g.font = '600 15px Inter'; g.fillStyle = '#0284c7'; g.fillText('PURE ESSENCE', 500, 560);
      g.font = '500 14px Inter'; g.fillStyle = '#64748b'; g.fillText('50 ml · eau de parfum', 500, 600);
    } else if (type === 'sneaker') {
      g.fillStyle = '#0f172a';
      g.beginPath(); g.moveTo(240, 640); g.quadraticCurveTo(300, 440, 360, 410); g.lineTo(520, 440);
      g.quadraticCurveTo(640, 520, 790, 560); g.quadraticCurveTo(840, 590, 830, 650); g.lineTo(240, 650); g.closePath(); g.fill();
      g.fillStyle = '#06b6d4'; g.beginPath(); g.roundRect(225, 640, 620, 52, 18); g.fill();
      g.fillStyle = '#e2e8f0'; for (let i = 0; i < 4; i++) { g.beginPath(); g.roundRect(400 + i * 34, 452 + i * 14, 26, 8, 4); g.fill(); }
      g.fillStyle = '#ffffff'; g.font = '800 30px "Bricolage Grotesque"'; g.fillText('SPEED RUNNER', 560, 600);
    } else {
      g.fillStyle = '#334155'; g.beginPath(); g.roundRect(440, 140, 120, 720, 24); g.fill();
      g.fillStyle = '#0f172a'; g.beginPath(); g.arc(500, 500, 180, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#94a3b8'; g.lineWidth = 16; g.stroke();
      g.strokeStyle = '#e2e8f0'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(500, 500); g.lineTo(500, 400); g.moveTo(500, 500); g.lineTo(570, 535); g.stroke();
      g.fillStyle = '#ffffff'; g.font = '700 22px "Bricolage Grotesque"'; g.fillText('CHRONO', 500, 600);
    }
    return c;
  }
  const DEMO_TEXT = {
    perfume: ['AURA PURE ESSENCE', '50 ml · Eau de Parfum'],
    sneaker: ['SPEED RUNNER', 'Sizes 38–45 · Black/Cyan'],
    watch: ['CHRONO CLASSIC', '42 mm · Steel case']
  };
  async function loadDemo(type) {
    loading('Loading demo…');
    await nextFrame();
    setImage(demoCanvas(type));
    setTitle(...DEMO_TEXT[type]);
    loading(null);
    await afterNewPhoto();
  }

  // =====================================================================
  //  CUTOUT ENGINE
  // =====================================================================
  function pushUndo() {
    if (!S.wctx) return;
    S.undo.push(S.wctx.getImageData(0, 0, S.work.width, S.work.height));
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    updateUndo();
  }
  function undo() {
    if (!S.undo.length) return;
    S.wctx.putImageData(S.undo.pop(), 0, 0);
    S.lastOpAuto = false;
    updateUndo(); computeBBox(); render();
    haptic(); toast('Undone');
  }
  function updateUndo() { $('undo-btn').disabled = S.undo.length === 0; }

  // Background = colour region connected to the photo's edges (keeps white labels inside the product).
  // =====================================================================
  //  AI REMOVER (v1.6.0): U²-Net small (Apache-2.0) on the phone with ONNX Runtime Web (MIT), files in ai/ (~15 MB,
  //  downloaded the first time, then kept for offline use by the service worker). The colour remover below is the
  //  "Simple remove" button and the fallback when the AI cannot load.
  // =====================================================================
  const AI = { ready: null, loaded: false };
  const aiUrl = (f) => new URL('ai/' + f, location.href).href;
  function loadAI() {
    if (!AI.ready) {
      AI.ready = (async () => {
        const ort = await import(aiUrl('ort.wasm.min.mjs'));
        ort.env.wasm.wasmPaths = aiUrl('');
        ort.env.wasm.numThreads = 1;               // no special server headers needed (GitHub Pages)
        const res = await fetch(aiUrl('u2netp.onnx'));
        if (!res.ok) throw new Error('model');
        const session = await ort.InferenceSession.create(await res.arrayBuffer(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        AI.loaded = true;
        return { ort, session };
      })().catch(e => { AI.ready = null; throw e; });
    }
    return AI.ready;
  }
  // How solid each pixel is (0 = background … 255 = product), at the working size. Pre/post-processing as in rembg.
  async function aiMask(photo) {
    const { ort, session } = await loadAI();
    const N = 320, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
    const small = document.createElement('canvas'); small.width = small.height = N;
    const sg = small.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingQuality = 'high'; sg.drawImage(photo, 0, 0, N, N);
    const px = sg.getImageData(0, 0, N, N).data;
    let max = 1e-6; for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
    const n = N * N, input = new Float32Array(3 * n);
    for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) input[c * n + p] = (px[p * 4 + c] / max - MEAN[c]) / STD[c];
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, N, N]) });
    const pred = out[session.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { if (pred[i] < lo) lo = pred[i]; if (pred[i] > hi) hi = pred[i]; }
    const m = sg.createImageData(N, N);
    for (let i = 0; i < n; i++) m.data[i * 4 + 3] = Math.round((pred[i] - lo) / Math.max(1e-6, hi - lo) * 255);
    sg.clearRect(0, 0, N, N); sg.putImageData(m, 0, 0);
    const w = photo.width, h = photo.height;
    const big = document.createElement('canvas'); big.width = w; big.height = h;
    const bg = big.getContext('2d', { willReadFrequently: true });
    bg.imageSmoothingQuality = 'high'; bg.drawImage(small, 0, 0, w, h);
    const a = bg.getImageData(0, 0, w, h).data, alpha = new Uint8ClampedArray(w * h);
    for (let p = 0; p < w * h; p++) {                // firmer: thin faint parts solid, faint haze gone
      const t = Math.min(1, Math.max(0, (a[p * 4 + 3] / 255 - 0.1) / 0.4));
      alpha[p] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    dropSpecks(alpha, w, h);
    return alpha;
  }
  // pieces much smaller than the biggest one (leftover haze) are removed
  function dropSpecks(alpha, w, h) {
    const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), sizes = [0];
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (alpha[s] < 128 || lab[s]) continue;
      next++; let top = 0, count = 0; stack[top++] = s; lab[s] = next;
      while (top) {
        const p = stack[--top]; count++;
        const x = p % w;
        const push = q => { if (!lab[q] && alpha[q] >= 128) { lab[q] = next; stack[top++] = q; } };
        if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (p >= w) push(p - w); if (p < n - w) push(p + w);
      }
      sizes.push(count);
    }
    if (next < 2) return;
    const min = Math.max(40, Math.max(...sizes) * 0.02);
    for (let p = 0; p < n; p++) if (lab[p] && sizes[lab[p]] < min) alpha[p] = 0;
    for (let p = 0; p < n; p++) if (!lab[p] && alpha[p] < 64) alpha[p] = 0;
  }
  async function aiRemoveBackground(fromLoad = false) {
    if (!S.raw) return toast('Add a photo first');
    loading(AI.loaded ? 'Removing background…' : 'Loading AI remover (~15 MB, first time only)…');
    await nextFrame();
    let alpha;
    try { alpha = await aiMask(S.raw); }
    catch (e) {
      console.error('AI remover', e);
      loading(null);
      toast('AI remover could not load (offline?) — used Simple remove');
      return autoRemoveBackground(fromLoad);
    }
    pushUndo();
    const w = S.work.width, h = S.work.height;
    const out = new ImageData(new Uint8ClampedArray(S.rawData.data), w, h);
    for (let p = 0; p < w * h; p++) out.data[p * 4 + 3] = Math.round(out.data[p * 4 + 3] * alpha[p] / 255);
    S.wctx.putImageData(out, 0, 0);
    S.lastOpAuto = false;                          // the tolerance slider is for Simple remove
    computeBBox();
    if (fromLoad) fitSubject();
    render();
    loading(null);
    toast(S.bbox ? 'Background removed (AI)' : 'Nothing left — try Simple remove');
  }

  async function autoRemoveBackground(fromLoad = false, replaceLast = false) {
    if (!S.raw) return toast('Add a photo first');
    loading('Removing background…');
    await nextFrame();

    if (!replaceLast) pushUndo();
    const w = S.work.width, h = S.work.height, n = w * h;
    const src = S.rawData.data;
    const out = new ImageData(new Uint8ClampedArray(src), w, h);
    const d = out.data;

    // Background colour = per-channel median of border pixels
    const rs = [], gs = [], bs = [];
    const step = Math.max(1, Math.floor((w + h) / 400));
    const sample = (x, y) => { const i = (y * w + x) * 4; rs.push(src[i]); gs.push(src[i + 1]); bs.push(src[i + 2]); };
    for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
    const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const br = med(rs), bg = med(gs), bb = med(bs);

    const tol = S.tol * 2.2, tolSq = tol * tol;
    const driftSq = (tol * 0.35) ** 2, farSq = (tol * 2) ** 2;
    const distBg = (i) => { const r = src[i] - br, g = src[i + 1] - bg, b = src[i + 2] - bb; return r * r + g * g + b * b; };

    const mask = new Uint8Array(n);      // 1 = background
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    const seed = (p) => { if (!mask[p] && distBg(p * 4) < tolSq) { mask[p] = 1; queue[qt++] = p; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

    while (qh < qt) {
      const p = queue[qh++], x = p % w, pi = p * 4;
      const tryN = (q) => {
        if (mask[q]) return;
        const qi = q * 4, db = distBg(qi);
        if (db < tolSq) { mask[q] = 1; queue[qt++] = q; return; }
        // allow gentle drift (shadows / light falloff on the backdrop)
        const r = src[qi] - src[pi], g = src[qi + 1] - src[pi + 1], b = src[qi + 2] - src[pi + 2];
        if (r * r + g * g + b * b < driftSq && db < farSq) { mask[q] = 1; queue[qt++] = q; }
      };
      if (x > 0) tryN(p - 1);
      if (x < w - 1) tryN(p + 1);
      if (p >= w) tryN(p - w);
      if (p < n - w) tryN(p + w);
    }

    // Remove tiny specks left in the background (islands < 0.05% of image)
    removeSmallIslands(mask, w, h, Math.max(24, Math.floor(n * 0.0005)));

    // Apply mask with a soft 1–2px edge
    for (let p = 0; p < n; p++) {
      if (mask[p]) { d[p * 4 + 3] = 0; continue; }
      const x = p % w;
      const edge = (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (p >= w && mask[p - w]) || (p < n - w && mask[p + w]);
      if (edge) {
        const db = Math.sqrt(distBg(p * 4));
        const a = Math.min(1, Math.max(0.35, (db - tol) / (tol * 0.8)));
        d[p * 4 + 3] = Math.round(d[p * 4 + 3] * a);
      }
    }

    S.wctx.putImageData(out, 0, 0);
    S.lastOpAuto = true;
    computeBBox();
    if (fromLoad) fitSubject();
    render();
    loading(null);
    if (!replaceLast) toast(S.bbox ? 'Background removed' : 'Nothing left — lower the tolerance');
  }

  function removeSmallIslands(mask, w, h, minSize) {
    const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (mask[s] || seen[s]) continue;
      let top = 0, count = 0; stack[top++] = s; seen[s] = 1;
      const members = [];
      while (top) {
        const p = stack[--top]; count++;
        if (count <= minSize) members.push(p);
        const x = p % w;
        const push = q => { if (!mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; } };
        if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
        if (p >= w) push(p - w); if (p < n - w) push(p + w);
      }
      if (count < minSize) for (const p of members) mask[p] = 1;
    }
  }

  function resetCutout() {
    if (!S.raw) return;
    pushUndo();
    S.wctx.putImageData(S.rawData, 0, 0);
    S.lastOpAuto = false;
    computeBBox(); render();
    toast('Original photo restored');
  }

  // Magic wand: flood-fills the contiguous colour area you tap
  function wandAt(cx, cy) {
    const { x: lx, y: ly } = toLocal(cx, cy);
    const w = S.work.width, h = S.work.height;
    const px = Math.floor(lx), py = Math.floor(ly);
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const img = S.wctx.getImageData(0, 0, w, h), d = img.data;
    const start = py * w + px;
    if (d[start * 4 + 3] === 0) return toast('Already transparent there');
    pushUndo();
    const tr = d[start * 4], tg = d[start * 4 + 1], tb = d[start * 4 + 2];
    const tolSq = (S.tol * 2.2) ** 2;
    const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(n);
    let top = 0, removed = 0;
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const p = stack[--top], i = p * 4;
      d[i + 3] = 0; removed++;
      const x = p % w;
      const push = q => {
        if (seen[q]) return; seen[q] = 1;
        const j = q * 4; if (d[j + 3] === 0) return;
        const r = d[j] - tr, g = d[j + 1] - tg, b = d[j + 2] - tb;
        if (r * r + g * g + b * b <= tolSq) stack[top++] = q;
      };
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w); if (p < n - w) push(p + w);
    }
    S.wctx.putImageData(img, 0, 0);
    S.lastOpAuto = false;
    computeBBox(); render();
    haptic(15);
    toast(`Removed ${removed > 9999 ? Math.round(removed / 1000) + 'k' : removed} px`);
  }

  // Erase / restore brush (soft edge, interpolated strokes)
  function brushAt(cx, cy, erase) {
    const { x: px, y: py } = toLocal(cx, cy);
    const w = S.work.width, h = S.work.height;
    const r = S.brush / S.scale;
    const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(w - 1, Math.ceil(px + r));
    const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(h - 1, Math.ceil(py + r));
    if (x0 > x1 || y0 > y1) return;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const img = S.wctx.getImageData(x0, y0, bw, bh), d = img.data, raw = S.rawData.data;
    const soft = Math.max(1, r * 0.25);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - px, y - py);
        if (dist > r) continue;
        const k = Math.min(1, (r - dist) / soft);          // 0 at rim → 1 inside
        const i = ((y - y0) * bw + (x - x0)) * 4;
        if (erase) {
          d[i + 3] = Math.round(d[i + 3] * (1 - k));
        } else {
          const j = (y * w + x) * 4;
          d[i] = raw[j]; d[i + 1] = raw[j + 1]; d[i + 2] = raw[j + 2];
          d[i + 3] = Math.max(d[i + 3], Math.round(raw[j + 3] * k));
        }
      }
    }
    S.wctx.putImageData(img, x0, y0);
  }

  function computeBBox() {
    if (!S.work) { S.bbox = null; return; }
    const w = S.work.width, h = S.work.height;
    const d = S.wctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] > 24) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    S.bbox = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // =====================================================================
  //  TRANSFORM
  // =====================================================================
  function toLocal(cx, cy) {
    const a = -S.rot * Math.PI / 180;
    const dx = cx - S.x, dy = cy - S.y;
    return {
      x: (dx * Math.cos(a) - dy * Math.sin(a)) / S.scale + S.work.width / 2,
      y: (dx * Math.sin(a) + dy * Math.cos(a)) / S.scale + S.work.height / 2
    };
  }
  function subjectBox() { return S.bbox || (S.work ? { x: 0, y: 0, w: S.work.width, h: S.work.height } : null); }

  // Puts the subject's centre at (tx, ty) on the output canvas
  function placeSubjectCenter(tx, ty) {
    const b = subjectBox(); if (!b) return;
    const ox = (b.x + b.w / 2 - S.work.width / 2) * S.scale;
    const oy = (b.y + b.h / 2 - S.work.height / 2) * S.scale;
    const a = S.rot * Math.PI / 180;
    S.x = tx - (ox * Math.cos(a) - oy * Math.sin(a));
    S.y = ty - (ox * Math.sin(a) + oy * Math.cos(a));
  }
  const targetCenterY = () => SIZE / 2 - (S.showBadge && S.title.trim() && S.badgeStyle !== 'clean-watermark' ? 36 : 0);
  function centerSubject() { placeSubjectCenter(SIZE / 2, targetCenterY()); syncAdjustUI(); render(); }
  function fitSubject() {
    const b = subjectBox(); if (!b) return;
    S.rot = 0;
    const room = S.showBadge && S.title.trim() && S.badgeStyle !== 'clean-watermark' ? 0.74 : 0.8;
    S.scale = (SIZE * room) / Math.max(b.w, b.h);
    placeSubjectCenter(SIZE / 2, targetCenterY());
    syncAdjustUI(); render();
  }
  function syncAdjustUI() {
    const pct = Math.round(S.scale * 100);
    $('scale-input').value = Math.min(300, Math.max(10, pct)); $('scale-val').textContent = pct + '%';
    $('rot-input').value = Math.round(S.rot); $('rot-val').textContent = Math.round(S.rot) + '°';
  }
  // Scale/rotate around the subject's current visual centre
  function setScaleRot(scale, rot) {
    const b = subjectBox(); if (!b) return;
    const cx = b.x + b.w / 2 - S.work.width / 2, cy = b.y + b.h / 2 - S.work.height / 2;
    const a = S.rot * Math.PI / 180;
    const vx = S.x + (cx * Math.cos(a) - cy * Math.sin(a)) * S.scale;
    const vy = S.y + (cx * Math.sin(a) + cy * Math.cos(a)) * S.scale;
    S.scale = Math.min(6, Math.max(0.05, scale)); S.rot = rot;
    placeSubjectCenter(vx, vy);
  }

  // =====================================================================
  //  RENDER
  // =====================================================================
  function render(target = ctx) {
    target.clearRect(0, 0, SIZE, SIZE);
    drawBackdrop(target);
    if (S.work) {
      if (S.shadow && S.bbox) drawShadow(target);
      target.save();
      target.imageSmoothingQuality = 'high';
      target.translate(S.x, S.y);
      target.rotate(S.rot * Math.PI / 180);
      target.scale(S.scale, S.scale);
      const cr = cropRect();
      const exp = Math.pow(2, S.exposure);
      target.filter = `brightness(${Math.max(0, (100 + S.brightness) * exp)}%) contrast(${100 + S.contrast}%) saturate(${100 + S.saturation}%)`;
      target.drawImage(S.work, cr.x, cr.y, cr.w, cr.h, -cr.w / 2, -cr.h / 2, cr.w, cr.h);
      target.filter = 'none';
      target.restore();
    }
    drawLogo(target);
    if (S.stamp) drawStamp(target);
    if (S.showBadge && S.title.trim()) drawBadge(target);
  }

  // 5H13 brand stamp: the official 5Hi3 logo tile
  let stampImg = null;
  loadImageFromURL('icons/brand-stamp.png').then(img => { stampImg = img; if (S.stamp) render(); }).catch(() => {});
  function drawStamp(c) {
    if (!stampImg) return;
    const m = 90, pad = 36;
    const [x, y] = { tl: [pad, pad], tr: [SIZE - m - pad, pad], bl: [pad, SIZE - m - pad], br: [SIZE - m - pad, SIZE - m - pad], bc: [(SIZE - m) / 2, SIZE - m - 25] }[S.stampPos] || [SIZE - m - pad, SIZE - m - pad];
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 12; c.shadowOffsetY = 4;
    c.fillStyle = '#2563EB'; c.beginPath(); c.roundRect(x, y, m, m, m * 0.22); c.fill();
    c.shadowColor = 'transparent';
    c.clip();
    c.imageSmoothingQuality = 'high';
    c.drawImage(stampImg, x, y, m, m);
    c.restore();
  }

  function backdropIsDark() {
    if (S.backdrop === 'dark-podium' || S.backdrop === 'sunset-cobalt' || S.backdrop === '5h13-signature') return true;
    if (S.backdrop === 'custom') {
      const v = parseInt(S.customBg.slice(1), 16);
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }
    return false; // transparent is treated as white (marketplace pages)
  }

  function drawBackdrop(c) {
    const bg = S.backdrop;
    if (bg === 'transparent') return;
    let fill;
    if (bg === 'white') fill = '#ffffff';
    else if (bg === 'custom') fill = S.customBg;
    else if (bg === 'warm-stone') { fill = c.createLinearGradient(0, 0, 0, SIZE); fill.addColorStop(0, '#fafaf9'); fill.addColorStop(1, '#d6d3d1'); }
    else if (bg === 'dark-podium') {
      fill = c.createRadialGradient(SIZE / 2, SIZE * 0.42, SIZE * 0.08, SIZE / 2, SIZE * 0.5, SIZE * 0.78);
      fill.addColorStop(0, '#334155'); fill.addColorStop(1, '#0b1120');
    } else if (bg === '5h13-signature') {
      fill = c.createLinearGradient(0, 0, SIZE, SIZE);
      fill.addColorStop(0, '#FBBF24'); fill.addColorStop(0.48, '#2563EB'); fill.addColorStop(1, '#EF4444');
      c.fillStyle = fill; c.fillRect(0, 0, SIZE, SIZE);
      fill = c.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.1, SIZE / 2, SIZE / 2, SIZE * 0.7);
      fill.addColorStop(0, 'rgba(255,255,255,0.2)'); fill.addColorStop(1, 'rgba(0,0,0,0.35)');
    } else if (bg === 'sunset-cobalt') {
      fill = c.createLinearGradient(0, 0, SIZE, SIZE);
      fill.addColorStop(0, '#1E40AF'); fill.addColorStop(0.5, '#312E81'); fill.addColorStop(1, '#B91C1C');
    } else if (bg === 'pastel-sky') {
      fill = c.createLinearGradient(0, 0, SIZE, SIZE);
      fill.addColorStop(0, '#e0f2fe'); fill.addColorStop(0.5, '#fce7f3'); fill.addColorStop(1, '#fef3c7');
    }
    c.fillStyle = fill; c.fillRect(0, 0, SIZE, SIZE);
  }

  function drawShadow(c) {
    const b = S.bbox;
    // bottom-centre of subject in canvas space (honours rotation)
    const lx = (b.x + b.w / 2 - S.work.width / 2) * S.scale;
    const ly = (b.y + b.h - S.work.height / 2) * S.scale;
    const a = S.rot * Math.PI / 180;
    const sx = S.x + lx * Math.cos(a) - ly * Math.sin(a);
    const sy = S.y + lx * Math.sin(a) + ly * Math.cos(a);
    const rw = Math.max(20, b.w * S.scale * 0.55), rh = Math.max(6, rw * 0.13);
    const strength = backdropIsDark() ? 0.55 : 0.32;
    c.save();
    c.translate(sx, sy - rh * 0.25);
    c.scale(1, rh / rw);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rw);
    g.addColorStop(0, `rgba(0,0,0,${strength})`);
    g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.3})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, rw, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function fitFont(c, text, weight, family, maxSize, maxWidth, style = '') {
    let size = maxSize;
    do { c.font = `${style} ${weight} ${size}px "${family}"`.trim(); if (c.measureText(text).width <= maxWidth) break; size -= 1; } while (size > 12);
    return size;
  }

  function drawBadge(c) {
    const title = S.title.trim(), sub = S.subtitle.trim();
    const dark = backdropIsDark();
    const ink = dark ? '#ffffff' : '#0f172a', inkSoft = dark ? 'rgba(255,255,255,.75)' : 'rgba(15,23,42,.62)';
    c.save();
    c.textBaseline = 'middle';
    switch (S.badgeStyle) {
      case 'minimal-pill': {
        const pw = Math.min(SIZE * 0.84, 760), ph = sub ? 120 : 92;
        const px = (SIZE - pw) / 2, py = SIZE - ph - 44;
        c.fillStyle = 'rgba(15,23,42,.84)';
        c.beginPath(); c.roundRect(px, py, pw, ph, ph / 2); c.fill();
        c.textAlign = 'center'; c.fillStyle = '#fff';
        fitFont(c, title, 800, S.font, 40, pw - 90);
        c.fillText(title, SIZE / 2, py + (sub ? ph * 0.38 : ph / 2));
        if (sub) { c.fillStyle = 'rgba(255,255,255,.72)'; fitFont(c, sub, 500, S.font, 24, pw - 90); c.fillText(sub, SIZE / 2, py + ph * 0.72); }
        break;
      }
      case 'editorial-bottom': {
        c.textAlign = 'left'; c.fillStyle = ink;
        fitFont(c, title, 800, S.font, 54, SIZE - 120);
        c.fillText(title, 60, SIZE - (sub ? 118 : 80));
        if (sub) { c.fillStyle = inkSoft; fitFont(c, sub, 500, S.font, 26, SIZE - 120); c.fillText(sub, 60, SIZE - 68); }
        const bar = c.createLinearGradient(60, 0, 124, 0); bar.addColorStop(0, '#FBBF24'); bar.addColorStop(0.5, '#2563EB'); bar.addColorStop(1, '#EF4444');
        c.fillStyle = bar; c.fillRect(60, SIZE - (sub ? 168 : 130), 64, 6);
        break;
      }
      case 'luxury-serif': {
        c.textAlign = 'center'; c.fillStyle = ink;
        fitFont(c, title, 600, 'Playfair Display', 50, SIZE - 160);
        c.fillText(title, SIZE / 2, SIZE - (sub ? 128 : 92));
        if (sub) { c.fillStyle = inkSoft; fitFont(c, `— ${sub} —`, 500, 'Playfair Display', 26, SIZE - 160, 'italic'); c.fillText(`— ${sub} —`, SIZE / 2, SIZE - 80); }
        break;
      }
      case 'bold-street': {
        c.textAlign = 'left';
        c.font = `700 40px "Space Grotesk"`;
        const size = fitFont(c, title, 700, 'Space Grotesk', 42, SIZE - 160);
        const tw = c.measureText(title).width;
        const bh = size + 34, by = SIZE - bh - (sub ? 96 : 56);
        c.fillStyle = '#FBBF24'; c.fillRect(48, by, tw + 56, bh);
        c.fillStyle = '#020617'; c.fillText(title, 76, by + bh / 2 + 2);
        if (sub) {
          fitFont(c, sub, 700, 'Space Grotesk', 24, SIZE - 160);
          const sw = c.measureText(sub).width;
          c.fillStyle = '#020617'; c.fillRect(48, by + bh, sw + 56, 46);
          c.fillStyle = '#ffffff'; c.fillText(sub, 76, by + bh + 24);
        }
        break;
      }
      default: { // clean-watermark
        const line = sub ? `${title}  ·  ${sub}` : title;
        c.textAlign = 'center'; c.fillStyle = dark ? 'rgba(255,255,255,.7)' : 'rgba(15,23,42,.55)';
        fitFont(c, line, 600, S.font, 24, SIZE - 120);
        c.fillText(line, SIZE / 2, SIZE - 40);
      }
    }
    c.restore();
  }

  function drawLogo(c) {
    if (S.activeStore < 0) return;
    const st = S.stores[S.activeStore], img = S.logoImgs[S.activeStore];
    if (!st || !img) return;
    const maxW = SIZE * st.size / 100, maxH = maxW * 0.6;
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k, h = img.height * k, m = 44;
    const pos = {
      tl: [m, m], tr: [SIZE - w - m, m], tc: [(SIZE - w) / 2, m],
      bl: [m, SIZE - h - m], br: [SIZE - w - m, SIZE - h - m]
    }[st.pos] || [SIZE - w - m, m];
    c.save();
    c.globalAlpha = st.opacity / 100;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, pos[0], pos[1], w, h);
    c.restore();
  }

  let rafPending = false;
  const scheduleRender = () => { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); };

  // =====================================================================
  //  POINTER / GESTURES
  // =====================================================================
  const pointers = new Map();
  let drag = null, pinch = null, stroke = null;

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * SIZE / r.width, y: (e.clientY - r.top) * SIZE / r.height, rx: e.clientX - r.left, ry: e.clientY - r.top, rw: r.width };
  }

  function showReticle(p) {
    const ret = $('reticle');
    if (!p || (S.tool !== 'erase' && S.tool !== 'restore')) { ret.classList.add('hidden'); return; }
    const dia = (S.brush * 2 / SIZE) * p.rw;
    ret.style.cssText = `left:${p.rx}px;top:${p.ry}px;width:${dia}px;height:${dia}px`;
    ret.classList.remove('hidden');
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, scale: S.scale, rot: S.rot, x: S.x, y: S.y };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!S.work) return;
    canvas.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {                 // two fingers always transform
      if (stroke) { stroke = null; }
      drag = null; startPinch(); showReticle(null);
      return;
    }
    if (pointers.size > 2) return;

    if (S.tool === 'wand') { wandAt(p.x, p.y); return; }
    if (S.tool === 'erase' || S.tool === 'restore') {
      pushUndo();
      stroke = { last: p, erase: S.tool === 'erase' };
      brushAt(p.x, p.y, stroke.erase); S.lastOpAuto = false;
      showReticle(p); scheduleRender();
      return;
    }
    drag = { sx: p.x, sy: p.y, ox: S.x, oy: S.y };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') showReticle(canvasPoint(e));
      return;
    }
    const p = canvasPoint(e);
    pointers.set(e.pointerId, p);

    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let rot = pinch.rot + (ang - pinch.ang) * 180 / Math.PI;
      rot = ((rot + 540) % 360) - 180;
      if (Math.abs(rot) < 3) rot = 0;                            // snap upright
      const scale = Math.min(6, Math.max(0.05, pinch.scale * d / pinch.d));
      // keep the point under the fingers' midpoint fixed
      const k = scale / pinch.scale, da = (rot - pinch.rot) * Math.PI / 180;
      const vx = pinch.x - pinch.mx, vy = pinch.y - pinch.my;
      S.x = mx + k * (vx * Math.cos(da) - vy * Math.sin(da));
      S.y = my + k * (vx * Math.sin(da) + vy * Math.cos(da));
      S.scale = scale; S.rot = rot;
      syncAdjustUI(); scheduleRender();
      return;
    }
    if (stroke) {
      const dist = Math.hypot(p.x - stroke.last.x, p.y - stroke.last.y);
      const stepLen = Math.max(2, S.brush / 3);
      const steps = Math.ceil(dist / stepLen);
      for (let i = 1; i <= steps; i++) {
        brushAt(stroke.last.x + (p.x - stroke.last.x) * i / steps, stroke.last.y + (p.y - stroke.last.y) * i / steps, stroke.erase);
      }
      stroke.last = p;
      showReticle(p); scheduleRender();
      return;
    }
    if (drag) {
      S.x = drag.ox + (p.x - drag.sx);
      S.y = drag.oy + (p.y - drag.sy);
      scheduleRender();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (stroke && pointers.size === 0) { stroke = null; computeBBox(); render(); }
    if (pinch && pointers.size < 2) { pinch = null; drag = null; }
    if (pointers.size === 0) { drag = null; if (e.pointerType !== 'mouse') showReticle(null); }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointers.size) showReticle(null); });
  canvas.addEventListener('wheel', (e) => {       // desktop: wheel zoom, shift+wheel rotate
    if (!S.work) return;
    e.preventDefault();
    if (e.shiftKey) setScaleRot(S.scale, Math.max(-180, Math.min(180, S.rot + Math.sign(e.deltaY) * 2)));
    else setScaleRot(S.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06), S.rot);
    syncAdjustUI(); scheduleRender();
  }, { passive: false });

  // =====================================================================
  //  TABS / PANELS
  // =====================================================================
  let currentTab = null;
  function setTab(tab) {
    currentTab = tab;
    $('panel').classList.toggle('hidden', !tab);
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab));
    if (tab !== 'cutout' && S.tool !== 'move') setTool('move', true);
    if (tab) $('panel').scrollTop = 0;
  }
  document.querySelectorAll('.nav-tab').forEach(b => b.addEventListener('click', () => {
    haptic(8); setTab(currentTab === b.dataset.tab ? null : b.dataset.tab);
  }));

  const MODE_LABEL = { move: 'Drag · pinch to resize', wand: 'Tap a colour to remove it', erase: 'Paint to erase', restore: 'Paint to bring back' };
  function setTool(tool, silent) {
    S.tool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('is-on', b.dataset.tool === tool));
    $('mode-label').textContent = MODE_LABEL[tool];
    showReticle(null);
    if (!silent) haptic(8);
  }
  document.querySelectorAll('.tool-btn').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  // ---------- Photo panel ----------
  $('gallery-input').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('camera-gallery-input').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (S.cam.mode === 'label') { closeCamera(); readLabelFile(f); } else handleFile(f);
  });
  $('auto-strip-toggle').checked = S.autoStrip;
  $('auto-strip-toggle').addEventListener('change', e => { S.autoStrip = e.target.checked; saveSettings(); });
  document.querySelectorAll('.demo-btn').forEach(b => b.addEventListener('click', () => { setTab(null); loadDemo(b.dataset.type); }));

  // ---------- Cutout panel ----------
  $('auto-cutout-btn').addEventListener('click', () => aiRemoveBackground(false));
  $('simple-cutout-btn').addEventListener('click', () => autoRemoveBackground(false));
  $('reset-cutout-btn').addEventListener('click', resetCutout);
  $('undo-btn').addEventListener('click', undo);
  let tolTimer;
  $('tol-input').addEventListener('input', e => {
    S.tol = +e.target.value; $('tol-val').textContent = S.tol;
    if (S.lastOpAuto) { clearTimeout(tolTimer); tolTimer = setTimeout(() => autoRemoveBackground(false, true), 220); }
  });
  $('brush-input').addEventListener('input', e => { S.brush = +e.target.value; $('brush-val').textContent = S.brush + 'px'; });

  // ---------- Label panel ----------
  function setTitle(title, subtitle) {
    S.title = title; S.subtitle = subtitle ?? S.subtitle;
    $('title-input').value = S.title; $('subtitle-input').value = S.subtitle;
    render();
  }
  $('badge-toggle').checked = S.showBadge;
  $('badge-toggle').addEventListener('change', e => { S.showBadge = e.target.checked; saveSettings(); render(); });
  $('title-input').addEventListener('input', e => { S.title = e.target.value; scheduleRender(); });
  $('subtitle-input').addEventListener('input', e => { S.subtitle = e.target.value; scheduleRender(); });
  $('style-select').value = S.badgeStyle;
  $('style-select').addEventListener('change', e => { S.badgeStyle = e.target.value; saveSettings(); render(); });
  $('font-select').value = S.font;
  $('font-select').addEventListener('change', e => { S.font = e.target.value; saveSettings(); render(); });

  // =====================================================================
  //  LABEL READING (OCR) — engine loads on first use, one worker reused, freed when idle
  // =====================================================================
  let tesseractLoading, ocrWorker = null, ocrIdleTimer = null, ocrBusy = false, ocrCancel = null;
  const OCR_MIN_CONF = 58;
  const OCR_LOAD_TIMEOUT = 60000;   // first-time download + start of the reader
  const OCR_PASS_TIMEOUT = 25000;   // one reading pass
  const OCR_BUDGET = 40000;         // stop trying extra passes after this
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    tesseractLoading ??= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL; s.onload = res; s.onerror = () => { tesseractLoading = null; s.remove(); rej(new Error('net')); };
      document.head.appendChild(s);
    });
    return tesseractLoading;
  }
  // Live progress from the reader so the screen never looks frozen
  let ocrPhase = 'Reading label…';
  function ocrLogger(m) {
    const pct = Math.round((m.progress || 0) * 100);
    const el = $('loader-text');
    if (m.status === 'recognizing text') el.textContent = `${ocrPhase} ${pct}%`;
    else if (/load|download|initializ/i.test(m.status)) el.textContent = `Preparing text reader… ${pct}%`;
  }
  async function getOcrWorker() {
    clearTimeout(ocrIdleTimer);
    if (!ocrWorker) {
      await loadTesseract();
      ocrWorker = await Tesseract.createWorker('eng', 1, { logger: ocrLogger, errorHandler: e => console.error('OCR worker', e) });
    }
    return ocrWorker;
  }
  async function killOcrWorker() {
    clearTimeout(ocrIdleTimer);
    const w = ocrWorker; ocrWorker = null;
    try { await w?.terminate(); } catch {}
  }
  function releaseOcrWorkerSoon() {
    clearTimeout(ocrIdleTimer);
    ocrIdleTimer = setTimeout(killOcrWorker, 30000);
  }
  // Race a step against Cancel and a time limit
  function guarded(promise, ms, cancelP) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
    return Promise.race([promise, timeout, cancelP]).finally(() => clearTimeout(t));
  }
  $('loader-cancel').addEventListener('click', () => ocrCancel?.());
  // Downscale (never above maxDim, never upscale more than 2x) and optionally rotate
  function ocrCanvas(source, maxDim, rot = 0) {
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    const k = Math.min(2, maxDim / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    const c = document.createElement('canvas');
    const side = rot % 180 !== 0;
    c.width = side ? h : w; c.height = side ? w : h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.translate(c.width / 2, c.height / 2); g.rotate(rot * Math.PI / 180);
    g.drawImage(source, -w / 2, -h / 2, w, h);
    return c;
  }
  function cleanLine(t) {
    return t.replace(/\|/g, '/').replace(/[\\_~`^*<>{}\[\]=»«“”"]/g, ' ').replace(/[—–]+/g, '-')
      .replace(/\s+/g, ' ').replace(/^[\s\-.,:;'/]+|[\s\-,:;'/]+$/g, '').trim();
  }
  // Confident lines only: trim junk words at the edges, require real letters/digits.
  // Each line keeps a normalised position so passes at different sizes can be merged.
  function goodLines(data, W, H) {
    const out = [];
    for (const l of data.lines || []) {
      let words = l.words && l.words.length ? [...l.words] : [{ text: l.text, confidence: l.confidence }];
      while (words.length && words[0].confidence < 40) words.shift();
      while (words.length && words[words.length - 1].confidence < 40) words.pop();
      if (!words.length) continue;
      const text = cleanLine(words.map(w => w.text).join(' '));
      const chars = text.replace(/\s/g, '');
      const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
      const len = words.reduce((a, w) => a + w.text.length, 0) || 1;
      const conf = words.reduce((a, w) => a + w.confidence * w.text.length, 0) / len;
      if (alnum < 3 || conf < OCR_MIN_CONF || alnum / chars.length < 0.6) continue;
      const bb = l.bbox || { x0: 0, y0: 0, x1: W, y1: H };
      out.push({ text, conf, alnum, x0: bb.x0 / W, x1: bb.x1 / W, y: (bb.y0 + bb.y1) / 2 / H });
    }
    return out;
  }
  // Combine two passes: same line (similar position) → keep the more confident reading
  function mergeLines(a, b) {
    const res = [...a];
    for (const l of b) {
      const i = res.findIndex(r => Math.abs(r.y - l.y) < 0.035 && Math.min(r.x1, l.x1) - Math.max(r.x0, l.x0) > 0.3 * Math.min(r.x1 - r.x0, l.x1 - l.x0));
      if (i < 0) res.push(l); else if (l.conf > res[i].conf) res[i] = l;
    }
    return res.sort((p, q) => p.y - q.y);
  }
  const scoreLines = ls => ls.reduce((a, l) => a + l.conf * l.alnum, 0);
  async function readAt(worker, source, maxDim, rot, cancelP) {
    const c = ocrCanvas(source, maxDim, rot);
    try {
      const res = await guarded(worker.recognize(c), OCR_PASS_TIMEOUT, cancelP);
      return goodLines(res.data, c.width, c.height);
    } finally { c.width = c.height = 0; }
  }

  function showOcrResults(lines, thumb) {
    const box = $('ocr-chips'); box.innerHTML = '';
    $('ocr-thumb').src = thumb;
    $('ocr-chips-box').classList.remove('hidden');
    $('ocr-empty').classList.toggle('hidden', lines.length > 0);
    lines.slice(0, 8).forEach(({ text }) => {
      const chip = document.createElement('button');
      chip.className = 'btn-touch rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-amber-200';
      chip.textContent = text;
      let pressTimer, long = false;
      chip.addEventListener('pointerdown', () => { long = false; pressTimer = setTimeout(() => { long = true; setTitle(S.title, text); haptic(20); toast('Set as subtitle'); }, 500); });
      chip.addEventListener('pointerup', () => clearTimeout(pressTimer));
      chip.addEventListener('pointerleave', () => clearTimeout(pressTimer));
      chip.addEventListener('contextmenu', ev => ev.preventDefault());
      chip.addEventListener('click', () => { if (!long) { setTitle(text.toUpperCase()); toast('Set as title'); } });
      box.appendChild(chip);
    });
  }

  // =====================================================================
  //  AI TEXT READING (Gemini) — optional. Each person uses their own free Google key,
  //  kept only on their device. If AI can't be used, the built-in reader takes over.
  // =====================================================================
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
  const AI_TIMEOUT = 30000;
  // Used only if the key's own model list can't be fetched. Google renames models often,
  // so the app normally asks Google which models this key can use (see pickModels).
  const AI_FALLBACK = { best: ['gemini-flash-latest', 'gemini-2.5-flash'], fast: ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite'] };
  const aiSaved = store.get('5h13.ai', {});
  const AIR = {
    key: store.get('5h13.geminiKey', '') || '',
    engine: aiSaved.engine === 'builtin' ? 'builtin' : 'ai',
    speed: aiSaved.speed === 'fast' ? 'fast' : 'best',
    models: aiSaved.models || null,     // { best: [...], fast: [...] }
    keyOk: aiSaved.keyOk ?? null        // true / false / null (unknown)
  };
  const saveAI = () => store.set('5h13.ai', { engine: AIR.engine, speed: AIR.speed, models: AIR.models, keyOk: AIR.keyOk });
  const aiActive = () => AIR.engine === 'ai' && !!AIR.key && AIR.keyOk !== false && navigator.onLine;

  class AIError extends Error {
    constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
  }
  async function aiFetch(key, path, body, signal) {
    let res;
    try {
      res = await fetch(`${GEMINI_API}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new AIError(0, 'network');
    }
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new AIError(res.status, json?.error?.message || '');
    return json;
  }

  // Ask Google which models this key may use (costs no reading quota)
  async function listModels(key, signal) {
    const names = [];
    let token = '';
    for (let page = 0; page < 4; page++) {
      const j = await aiFetch(key, `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, null, signal);
      for (const m of j?.models || []) {
        if ((m.supportedGenerationMethods || []).includes('generateContent')) names.push(String(m.name).replace(/^models\//, ''));
      }
      token = j?.nextPageToken;
      if (!token) break;
    }
    return names;
  }
  // Prefer Google's "latest" aliases, then the newest stable Flash / Flash-Lite
  function pickModels(names) {
    const ver = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)-/) || [])[1] || 0);
    const newest = re => names.filter(n => re.test(n)).sort((a, b) => ver(b) - ver(a));
    const best = [...(names.includes('gemini-flash-latest') ? ['gemini-flash-latest'] : []), ...newest(/^gemini-\d+(\.\d+)?-flash$/)].slice(0, 3);
    const fast = [...(names.includes('gemini-flash-lite-latest') ? ['gemini-flash-lite-latest'] : []), ...newest(/^gemini-\d+(\.\d+)?-flash-lite$/)].slice(0, 3);
    return best.length || fast.length ? { best, fast } : null;
  }
  function modelOrder() {
    const m = AIR.models || AI_FALLBACK;
    const list = AIR.speed === 'fast' ? [...m.fast, ...m.best] : [...m.best, ...m.fast];
    return [...new Set(list)].slice(0, 3);
  }

  const AI_PROMPT =
    'This photo shows a product or its box/label, taken for an online store listing. ' +
    'Read the printed text exactly as written, keeping spelling, numbers and units. ' +
    'Return JSON: "title" = the product or brand name to use as the listing title (short, as printed); ' +
    '"subtitle" = the key detail such as variant, size, volume, weight or model (e.g. "50 ml", "Size 42"), or "" if none; ' +
    '"lines" = every distinct line of readable text, top to bottom. ' +
    'If nothing is readable, return empty strings and an empty list. Never invent or guess text that is not visible.';
  const AI_SCHEMA = {
    type: 'OBJECT',
    properties: { title: { type: 'STRING' }, subtitle: { type: 'STRING' }, lines: { type: 'ARRAY', items: { type: 'STRING' } } },
    required: ['title', 'subtitle', 'lines']
  };

  async function aiReadLabel(source, cancelP) {
    const ctrl = new AbortController();
    cancelP.catch(() => ctrl.abort());
    const run = async () => {
      // First use with this key: find out which models it can use
      if (!AIR.models) {
        try { AIR.models = pickModels(await listModels(AIR.key, ctrl.signal)); saveAI(); }
        catch (e) { if (e.name === 'AbortError' || [400, 401, 403].includes(e.status)) throw e; }
      }
      const c = ocrCanvas(source, 1600);
      const data = c.toDataURL('image/jpeg', 0.9).split(',')[1];
      c.width = c.height = 0;
      const body = {
        contents: [{ parts: [{ text: AI_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: AI_SCHEMA }
      };
      let lastErr;
      for (const model of modelOrder()) {
        try {
          const j = await aiFetch(AIR.key, `models/${encodeURIComponent(model)}:generateContent`, body, ctrl.signal);
          const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
          if (!text) throw new AIError(0, 'empty');
          const r = JSON.parse(text);
          return {
            title: String(r.title || '').trim(),
            subtitle: String(r.subtitle || '').trim(),
            lines: Array.isArray(r.lines) ? r.lines.map(s => String(s).trim()).filter(Boolean) : []
          };
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          lastErr = e;
          // Model gone, or not on the free tier ("limit: 0") → try the next model
          const msg = (e.message || '').toLowerCase();
          const tryNext = e.status === 404 || (e.status === 429 && /limit:\s*0\b/.test(msg)) || (e.status === 400 && /model/.test(msg) && !/api key/.test(msg));
          if (!tryNext) throw e;
          if (e.status === 404) { AIR.models = null; saveAI(); }   // re-check the model list next time
        }
      }
      throw lastErr || new AIError(0, 'no model');
    };
    try {
      return await guarded(run(), AI_TIMEOUT, cancelP);
    } catch (e) {
      ctrl.abort();
      if (e.name === 'AbortError') throw new Error('cancel');
      throw e;
    }
  }

  // Plain-language reason, shared by scanning and the key test
  function aiProblem(e) {
    const m = (e?.message || '').toLowerCase();
    if (e?.message === 'timeout') return { text: 'AI took too long', keyBad: false };
    if (e?.status === 400 && /api key|api_key/.test(m)) return { text: 'Google doesn’t recognise this key', keyBad: true };
    if (e?.status === 403 && /location|region|country/.test(m)) return { text: 'Gemini isn’t available in your country', keyBad: true };
    if (e?.status === 401 || e?.status === 403) return { text: 'This key isn’t allowed to use Gemini', keyBad: true };
    if (e?.status === 429) return { text: 'The key’s free limit is used up for now', keyBad: false };
    if (e?.status === 0 && e?.message === 'network') return { text: 'Couldn’t reach Google', keyBad: false };
    if (e?.status >= 500) return { text: 'Google’s AI is busy right now', keyBad: false };
    return { text: 'AI reading failed', keyBad: false };
  }

  function applyAIResult(r, thumb) {
    const seen = new Set(), lines = [];
    for (const t of [r.title, r.subtitle, ...r.lines]) {
      const s = cleanLine(t || '');
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); lines.push({ text: s }); }
    }
    showOcrResults(lines, thumb);
    if (!lines.length) { toast('Couldn’t read it clearly — move closer, hold steady, avoid glare'); return; }
    if (!S.showBadge) { S.showBadge = true; $('badge-toggle').checked = true; saveSettings(); }
    setTitle((cleanLine(r.title) || lines[0].text).toUpperCase(), cleanLine(r.subtitle) || S.subtitle);
    toast('Read with AI — tap a line to use it');
  }

  // ---------- AI panel ----------
  function syncAIUI() {
    $('ai-engine-select').value = AIR.engine;
    $('ai-speed-select').value = AIR.speed;
    $('ai-speed-select').disabled = AIR.engine !== 'ai';
    const pill = $('ai-status');
    pill.classList.remove('is-ready', 'is-warn');
    if (AIR.engine !== 'ai') pill.textContent = 'Off';
    else if (!AIR.key) pill.textContent = 'No key';
    else if (AIR.keyOk === false) { pill.textContent = 'Key problem'; pill.classList.add('is-warn'); }
    else { pill.textContent = 'On'; pill.classList.add('is-ready'); }
  }
  function setKeyResult(text, tone) {
    const el = $('ai-key-result');
    el.classList.toggle('hidden', !text);
    el.className = `${text ? '' : 'hidden '}text-[11px] leading-snug ai-${tone || 'info'}`;
    el.textContent = text || '';
  }
  let keyTestBusy = false;
  async function checkKey(save) {
    if (keyTestBusy) return;
    const key = $('ai-key-input').value.trim();
    if (!key) return setKeyResult('Paste your key first.', 'warn');
    if (!navigator.onLine) {
      if (save) { storeKey(key, null); return setKeyResult('Saved. You’re offline, so it will be checked on the next scan.', 'warn'); }
      return setKeyResult('You’re offline — connect to the internet to test the key.', 'warn');
    }
    keyTestBusy = true;
    $('ai-key-test').disabled = $('ai-key-save').disabled = true;
    setKeyResult('Checking with Google…', 'info');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let names;
      try { names = await listModels(key, ctrl.signal); } finally { clearTimeout(t); }
      const models = pickModels(names);
      storeKey(key, true, models);
      if (!models) setKeyResult('✓ Key works and is saved — but no suitable Gemini model was found for it right now. The built-in reader will be used.', 'warn');
      else setKeyResult(`✓ Key works and is saved. AI reading is on${AIR.engine === 'ai' ? '' : ' (choose “AI first” above to use it)'}.`, 'ok');
      haptic(20);
    } catch (e) {
      if (e.name === 'AbortError') {
        if (save) storeKey(key, null);
        setKeyResult(save ? 'Saved, but Google took too long to answer. It will be checked on the next scan.' : 'Google took too long to answer — try again.', 'warn');
      } else {
        const p = aiProblem(e);
        const region = e.status === 403 && /location|region|country/i.test(e.message || '');
        if (region) setKeyResult('✕ Gemini isn’t available in your country, so the built-in reader will be used.', 'bad');
        else if (p.keyBad) setKeyResult(`✕ ${p.text}. Copy the whole key again from Google AI Studio.${save ? ' (Not saved.)' : ''}`, 'bad');
        else {
          if (save) storeKey(key, null);
          setKeyResult(`⚠ ${p.text}.${save ? ' The key is saved and will be checked on the next scan.' : ' Try again later.'}`, 'warn');
        }
      }
    } finally {
      keyTestBusy = false;
      $('ai-key-test').disabled = $('ai-key-save').disabled = false;
    }
  }
  function storeKey(key, ok, models) {
    if (key !== AIR.key) AIR.models = null;
    AIR.key = key; AIR.keyOk = ok;
    if (models !== undefined) AIR.models = models;
    store.set('5h13.geminiKey', key);
    saveAI(); syncAIUI();
    $('ai-key-input').type = 'password'; $('ai-key-show').textContent = 'Show';
  }

  $('ai-key-input').value = AIR.key;
  syncAIUI();
  $('ai-engine-select').addEventListener('change', e => { AIR.engine = e.target.value; saveAI(); syncAIUI(); });
  $('ai-speed-select').addEventListener('change', e => { AIR.speed = e.target.value; saveAI(); });
  $('ai-key-input').addEventListener('input', () => setKeyResult(''));
  $('ai-key-show').addEventListener('click', () => {
    const show = $('ai-key-input').type === 'password';
    $('ai-key-input').type = show ? 'text' : 'password';
    $('ai-key-show').textContent = show ? 'Hide' : 'Show';
  });
  $('ai-key-save').addEventListener('click', () => checkKey(true));
  $('ai-key-test').addEventListener('click', () => checkKey(false));
  $('ai-key-remove').addEventListener('click', () => {
    AIR.key = ''; AIR.keyOk = null; AIR.models = null;
    try { localStorage.removeItem('5h13.geminiKey'); } catch {}
    $('ai-key-input').value = '';
    saveAI(); syncAIUI();
    setKeyResult('Key removed from this device.', 'info');
  });

  async function readLabel(source) {
    if (ocrBusy) return toast('Still reading the last label…');
    ocrBusy = true;
    setTab('text');
    const cancelP = new Promise((_, rej) => { ocrCancel = () => rej(new Error('cancel')); });
    cancelP.catch(() => {});
    $('loader-cancel').classList.remove('hidden');
    let started = Date.now(), aiNote = '';
    const timeLeft = () => OCR_BUDGET - (Date.now() - started);
    try {
      const thumb = ocrCanvas(source, 320).toDataURL('image/jpeg', 0.7);
      // 0) AI first, when the person has turned it on with their own key
      if (aiActive()) {
        loading('Reading label with AI…');
        try {
          applyAIResult(await aiReadLabel(source, cancelP), thumb);
          if (AIR.keyOk !== true) { AIR.keyOk = true; saveAI(); syncAIUI(); }
          return;
        } catch (e) {
          if (e.message === 'cancel') throw e;
          console.warn('AI reading failed', e);
          const p = aiProblem(e);
          if (p.keyBad) { AIR.keyOk = false; saveAI(); syncAIUI(); }
          aiNote = /^(Google|Gemini|AI)\b/.test(p.text) ? p.text : p.text.charAt(0).toLowerCase() + p.text.slice(1);
          toast(`${p.text} — using the built-in reader`);
          started = Date.now();
        }
      } else if (AIR.engine === 'ai' && AIR.key && AIR.keyOk !== false && !navigator.onLine) {
        aiNote = 'you’re offline';
      }
      loading(ocrWorker ? 'Reading label…' : 'Preparing text reader… (first time downloads ~5 MB)');
      const worker = await guarded(getOcrWorker(), OCR_LOAD_TIMEOUT, cancelP);
      // 1) Upright at a size that suits big label text
      ocrPhase = 'Reading label…';
      let best = await readAt(worker, source, 1000, 0, cancelP);
      // 2) Weak? Try larger (small print reads better bigger) and keep the best of each line
      if (scoreLines(best) < 2500 && timeLeft() > 0) {
        ocrPhase = 'Looking closer…';
        best = mergeLines(best, await readAt(worker, source, 1600, 0, cancelP));
      }
      // 3) Still weak? The photo may be sideways or upside down
      for (const rot of [90, 270, 180]) {
        if (scoreLines(best) >= 2500 || timeLeft() <= 0) break;
        ocrPhase = 'Checking rotation…';
        const lines = await readAt(worker, source, 800, rot, cancelP);
        if (scoreLines(lines) > scoreLines(best) * 1.3) best = lines;
      }
      showOcrResults(best, thumb);
      if (!best.length) { toast('Couldn’t read it clearly — move closer, hold steady, avoid glare'); return; }
      if (!S.showBadge) { S.showBadge = true; $('badge-toggle').checked = true; saveSettings(); }
      setTitle(best[0].text.toUpperCase(), best[1]?.text ?? S.subtitle);
      toast(aiNote ? `Text found with the built-in reader (AI: ${aiNote})` : 'Text found — tap a line to use it');
    } catch (err) {
      console.error(err);
      const readerWasReady = !!ocrWorker;
      await killOcrWorker();            // stops any reading still running in the background
      if (err.message === 'cancel') toast('Stopped');
      else if (err.message === 'timeout') toast(readerWasReady ? 'Took too long — try a closer, sharper photo' : 'Text reader download timed out — check internet');
      else toast(navigator.onLine ? 'Text reading failed — try again' : 'Text reading needs internet the first time');
    } finally {
      ocrBusy = false; ocrCancel = null;
      $('loader-cancel').classList.add('hidden');
      loading(null);
      if (ocrWorker) releaseOcrWorkerSoon();
    }
  }
  async function readLabelFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try { await readLabel(await loadImageFromURL(url)); }
    catch { toast('Could not open that image'); }
    finally { URL.revokeObjectURL(url); }
  }
  $('scan-label-btn').addEventListener('click', () => { if (!ocrBusy) openCamera('label'); });
  $('label-file-input').addEventListener('change', e => { readLabelFile(e.target.files[0]); e.target.value = ''; });

  // ---------- Store logo panel ----------
  function saveStores() {
    store.set('5h13.activeStore', S.activeStore);
    if (!store.set('5h13.stores', S.stores)) toast('Phone storage full — logo not saved');
  }
  async function decodeLogos() {
    S.logoImgs = await Promise.all(S.stores.map(st => st.logo ? loadImageFromURL(st.logo).catch(() => null) : null));
  }
  function renderStoreUI() {
    const chips = $('store-chips'); chips.innerHTML = '';
    const make = (idx, label) => {
      const b = document.createElement('button');
      b.className = 'chip truncate !py-2' + (S.activeStore === idx ? ' is-on' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        haptic(8);
        S.activeStore = idx; if (idx >= 0) S.editStore = idx;
        saveStores(); renderStoreUI(); render();
      });
      chips.appendChild(b);
    };
    make(-1, 'None');
    S.stores.forEach((st, i) => make(i, st.name || `Store ${i + 1}`));

    const ed = $('store-editor');
    ed.classList.toggle('hidden', S.activeStore < 0);
    const st = S.stores[S.editStore];
    $('store-name-input').value = st.name;
    $('logo-preview').classList.toggle('hidden', !st.logo);
    $('logo-placeholder').classList.toggle('hidden', !!st.logo);
    if (st.logo) $('logo-preview').src = st.logo;
    $('logo-remove-btn').disabled = !st.logo;
    document.querySelectorAll('.pos-btn').forEach(b => b.classList.toggle('is-on', b.dataset.pos === st.pos));
    $('logo-size-input').value = st.size; $('logo-size-val').textContent = st.size + '%';
    $('logo-op-input').value = st.opacity; $('logo-op-val').textContent = st.opacity + '%';
    $('store-indicator').textContent = S.activeStore < 0 ? 'No store logo' : (S.stores[S.activeStore].name || 'Store') + (S.logoImgs[S.activeStore] ? '' : ' · no logo yet');
  }
  $('store-name-input').addEventListener('input', e => {
    S.stores[S.editStore].name = e.target.value; saveStores();
    const chip = $('store-chips').children[S.editStore + 1]; if (chip) chip.textContent = e.target.value || `Store ${S.editStore + 1}`;
    $('store-indicator').textContent = e.target.value || 'Store';
  });
  $('logo-input').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImageFromURL(url);
      const iw = img.naturalWidth || 600, ih = img.naturalHeight || 600;
      const k = Math.min(1, 600 / Math.max(iw, ih));
      const c = document.createElement('canvas');
      c.width = Math.round(iw * k); c.height = Math.round(ih * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/png');
      S.stores[S.editStore].logo = dataUrl;
      S.logoImgs[S.editStore] = await loadImageFromURL(dataUrl);
      saveStores(); renderStoreUI(); render();
      toast('Logo saved for ' + (S.stores[S.editStore].name || 'store'));
    } catch { toast('Could not read that logo'); }
    finally { URL.revokeObjectURL(url); }
  });
  $('logo-remove-btn').addEventListener('click', () => {
    S.stores[S.editStore].logo = null; S.logoImgs[S.editStore] = null;
    saveStores(); renderStoreUI(); render();
  });
  document.querySelectorAll('.pos-btn').forEach(b => b.addEventListener('click', () => {
    S.stores[S.editStore].pos = b.dataset.pos; saveStores(); renderStoreUI(); render();
  }));
  $('logo-size-input').addEventListener('input', e => { S.stores[S.editStore].size = +e.target.value; $('logo-size-val').textContent = e.target.value + '%'; scheduleRender(); });
  $('logo-size-input').addEventListener('change', saveStores);
  $('logo-op-input').addEventListener('input', e => { S.stores[S.editStore].opacity = +e.target.value; $('logo-op-val').textContent = e.target.value + '%'; scheduleRender(); });
  $('logo-op-input').addEventListener('change', saveStores);

  // ---------- 5H13 stamp ----------
  function syncStampUI() {
    $('stamp-toggle').checked = S.stamp;
    $('stamp-pos').classList.toggle('opacity-40', !S.stamp);
    document.querySelectorAll('.stamp-pos-btn').forEach(b => b.classList.toggle('is-on', b.dataset.pos === S.stampPos));
  }
  $('stamp-toggle').addEventListener('change', e => { S.stamp = e.target.checked; saveSettings(); syncStampUI(); render(); });
  document.querySelectorAll('.stamp-pos-btn').forEach(b => b.addEventListener('click', () => {
    S.stampPos = b.dataset.pos; S.stamp = true; saveSettings(); syncStampUI(); render();
  }));

  // ---------- Backdrop panel ----------
  function syncBackdropUI() {
    document.querySelectorAll('.bg-btn').forEach(b => b.classList.toggle('is-on', b.dataset.bg === S.backdrop));
  }
  document.querySelectorAll('.bg-btn').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.bg === 'custom') return; // handled by colour input
    haptic(8); S.backdrop = b.dataset.bg; saveSettings(); syncBackdropUI(); render();
  }));
  $('custom-color').value = S.customBg;
  $('custom-color').addEventListener('input', e => { S.backdrop = 'custom'; S.customBg = e.target.value; syncBackdropUI(); scheduleRender(); });
  $('custom-color').addEventListener('change', saveSettings);
  $('shadow-toggle').checked = S.shadow;
  $('shadow-toggle').addEventListener('change', e => { S.shadow = e.target.checked; saveSettings(); render(); });

  // ---------- Photo corrections and crop ----------
  function cropRect() {
    if (!S.work) return { x: 0, y: 0, w: 1, h: 1 };
    const c = S.crop;
    const x = Math.round(S.work.width * c.x / 100), y = Math.round(S.work.height * c.y / 100);
    const w = Math.max(1, Math.round(S.work.width * c.w / 100));
    const h = Math.max(1, Math.round(S.work.height * c.h / 100));
    return { x: Math.min(x, S.work.width - 1), y: Math.min(y, S.work.height - 1), w: Math.min(w, S.work.width - x), h: Math.min(h, S.work.height - y) };
  }
  function syncPhotoAdjustUI() {
    const pairs = [['brightness', S.brightness], ['contrast', S.contrast], ['saturation', S.saturation], ['exposure', S.exposure]];
    for (const [id, value] of pairs) {
      if ($(id + '-input')) $(id + '-input').value = value;
      if ($(id + '-val')) $(id + '-val').textContent = id === 'exposure' ? Number(value).toFixed(1) : `${value > 0 ? '+' : ''}${value}`;
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if ($(`crop-${k}-input`)) $(`crop-${k}-input`).value = S.crop[k];
      if ($(`crop-${k}-val`)) $(`crop-${k}-val`).textContent = `${Math.round(S.crop[k])}%`;
    }
  }
  function bindCorrection(id, min, max) {
    $(id + '-input').addEventListener('input', e => {
      S[id] = Math.min(max, Math.max(min, +e.target.value));
      $(id + '-val').textContent = id === 'exposure' ? S[id].toFixed(1) : `${S[id] > 0 ? '+' : ''}${S[id]}`;
      scheduleRender();
    });
  }
  bindCorrection('brightness', -100, 100);
  bindCorrection('contrast', -100, 100);
  bindCorrection('saturation', -100, 100);
  bindCorrection('exposure', -2, 2);
  function normalizeCrop(changed) {
    const c = S.crop;
    c.w = Math.max(10, Math.min(100, c.w)); c.h = Math.max(10, Math.min(100, c.h));
    c.x = Math.max(0, Math.min(100 - c.w, c.x)); c.y = Math.max(0, Math.min(100 - c.h, c.y));
    if (changed === 'x' && c.x + c.w > 100) c.w = 100 - c.x;
    if (changed === 'y' && c.y + c.h > 100) c.h = 100 - c.y;
    syncPhotoAdjustUI(); scheduleRender();
  }
  for (const k of ['x', 'y', 'w', 'h']) $('crop-' + k + '-input').addEventListener('input', e => { S.crop[k] = +e.target.value; normalizeCrop(k); });
  $('crop-square-btn').addEventListener('click', () => {
    if (!S.work) return toast('Add a photo first');
    const side = Math.min(S.crop.w, S.crop.h); S.crop.w = S.crop.h = side; normalizeCrop('w');
  });
  $('crop-reset-btn').addEventListener('click', () => { S.crop = { x: 0, y: 0, w: 100, h: 100 }; syncPhotoAdjustUI(); render(); });
  $('apply-crop-btn').addEventListener('click', () => {
    if (!S.work) return toast('Add a photo first');
    const r = cropRect();
    if (r.x === 0 && r.y === 0 && r.w === S.work.width && r.h === S.work.height) return toast('Crop already covers the full photo');
    pushUndo();
    const cropCanvas = source => { const c = document.createElement('canvas'); c.width = r.w; c.height = r.h; c.getContext('2d', { willReadFrequently: true }).drawImage(source, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); return c; };
    S.raw = cropCanvas(S.raw); S.work = cropCanvas(S.work);
    S.rawData = S.raw.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.w, r.h);
    S.wctx = S.work.getContext('2d', { willReadFrequently: true });
    S.crop = { x: 0, y: 0, w: 100, h: 100 }; S.undo = []; updateUndo();
    computeBBox(); fitSubject(); syncPhotoAdjustUI(); toast('Crop applied');
  });
  $('reset-photo-adjust-btn').addEventListener('click', () => {
    S.brightness = S.contrast = S.saturation = S.exposure = 0;
    syncPhotoAdjustUI(); render(); toast('Photo corrections reset');
  });
  // ---------- Adjust panel ----------
  $('scale-input').addEventListener('input', e => { setScaleRot(+e.target.value / 100, S.rot); $('scale-val').textContent = e.target.value + '%'; scheduleRender(); });
  $('rot-input').addEventListener('input', e => { setScaleRot(S.scale, +e.target.value); $('rot-val').textContent = e.target.value + '°'; scheduleRender(); });
  $('center-btn').addEventListener('click', () => { haptic(); centerSubject(); });
  $('fit-btn').addEventListener('click', () => { haptic(); fitSubject(); });
  $('straight-btn').addEventListener('click', () => { haptic(); setScaleRot(S.scale, 0); syncAdjustUI(); render(); });
  $('quick-fit-btn').addEventListener('click', () => { haptic(); fitSubject(); toast('Centered & fitted'); });

  // =====================================================================
  //  CAMERA
  // =====================================================================
  async function openCamera(mode) {
    if (mode) S.cam.mode = mode;
    const label = S.cam.mode === 'label';
    $('camera-hint').textContent = label ? 'Fit the box label in the frame' : 'Fill the square';
    const guide = $('camera-guide');
    guide.classList.toggle('aspect-square', !label);
    guide.classList.toggle('aspect-[4/3]', label);
    guide.classList.toggle('border-amber-400/80', !label);
    guide.classList.toggle('border-indigo-400/90', label);
    $('camera-tip').classList.toggle('hidden', !label);
    if (!navigator.mediaDevices?.getUserMedia) return toast(label ? 'Camera needs HTTPS — use Label photo' : 'Camera needs HTTPS — use Photo library');
    try {
      S.cam.stream?.getTracks().forEach(t => t.stop());
      S.cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: S.cam.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
      });
      const v = $('camera-feed');
      v.srcObject = S.cam.stream;
      const track = S.cam.stream.getVideoTracks()[0];
      if (track?.getCapabilities?.().focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      S.cam.torch = false;
      setupZoom(track);
      $('camera-modal').classList.remove('hidden'); $('camera-modal').classList.add('flex');
    } catch (err) {
      console.error(err);
      toast(err.name === 'NotAllowedError' ? 'Camera permission denied' : 'Camera not available');
    }
  }
  // ---------- Zoom: real (optical/sensor) zoom when the browser offers it, digital otherwise ----------
  const zoom = { z: 1, max: 4, hw: null, pending: null, applying: false };
  function setupZoom(track) {
    const caps = track?.getCapabilities?.() || {};
    const zc = caps.zoom;
    const base = zc && zc.min > 0 ? zc.min : 1;
    zoom.hw = zc && zc.max / base >= 2 ? { track, base, min: zc.min, max: zc.max, step: zc.step || 0.1 } : null;
    zoom.max = zoom.hw ? Math.min(zoom.hw.max / base, 8) : 4;
    document.querySelectorAll('.zoom-chip').forEach(b => b.classList.toggle('hidden', +b.dataset.z > zoom.max + 0.01));
    setZoom(1, true);
  }
  function videoTransform() {
    const mirror = S.cam.facing === 'user' ? 'scaleX(-1) ' : '';
    return mirror + (zoom.hw || zoom.z === 1 ? '' : `scale(${zoom.z})`);
  }
  async function pushHardwareZoom() {
    if (zoom.applying || zoom.pending == null) return;
    zoom.applying = true;
    const value = zoom.pending; zoom.pending = null;
    try { await zoom.hw.track.applyConstraints({ advanced: [{ zoom: value }] }); }
    catch { zoom.hw = null; zoom.max = 4; $('camera-feed').style.transform = videoTransform(); }   // fall back to digital
    zoom.applying = false;
    if (zoom.pending != null) pushHardwareZoom();
  }
  function setZoom(z, silent) {
    z = Math.min(zoom.max, Math.max(1, z));
    zoom.z = Math.round(z * 10) / 10;
    if (zoom.hw) {
      const { base, min, max, step } = zoom.hw;
      zoom.pending = Math.min(max, Math.max(min, Math.round(base * zoom.z / step) * step));
      pushHardwareZoom();
    }
    $('camera-feed').style.transform = videoTransform();
    $('zoom-label').textContent = zoom.z === 1 ? 'Pinch to zoom' : `${zoom.z.toFixed(1)}× ${zoom.hw ? '' : 'digital'}`.trim();
    document.querySelectorAll('.zoom-chip').forEach(b => b.classList.toggle('is-on', Math.abs(+b.dataset.z - zoom.z) < 0.05));
    if (!silent) haptic(6);
  }
  document.querySelectorAll('.zoom-chip').forEach(b => b.addEventListener('click', () => setZoom(+b.dataset.z)));
  // Pinch anywhere on the preview
  const camPts = new Map(); let camPinch = null;
  const stage = $('camera-stage');
  stage.addEventListener('pointerdown', e => {
    camPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (camPts.size === 2) { const [a, b] = [...camPts.values()]; camPinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom.z }; }
  });
  stage.addEventListener('pointermove', e => {
    if (!camPts.has(e.pointerId)) return;
    camPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (camPinch && camPts.size === 2) { const [a, b] = [...camPts.values()]; setZoom(camPinch.z * Math.hypot(a.x - b.x, a.y - b.y) / camPinch.d, true); }
  });
  const camUp = e => { camPts.delete(e.pointerId); if (camPts.size < 2) camPinch = null; };
  stage.addEventListener('pointerup', camUp); stage.addEventListener('pointercancel', camUp); stage.addEventListener('pointerleave', camUp);
  // Desktop: mouse wheel zooms
  stage.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoom.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), true); }, { passive: false });

  function closeCamera() {
    S.cam.stream?.getTracks().forEach(t => t.stop());
    S.cam.stream = null;
    $('camera-feed').srcObject = null;
    $('camera-modal').classList.add('hidden'); $('camera-modal').classList.remove('flex');
  }
  $('open-camera-btn').addEventListener('click', () => { setTab(null); openCamera('product'); });
  $('camera-close-btn').addEventListener('click', closeCamera);
  $('flip-btn').addEventListener('click', () => { haptic(); S.cam.facing = S.cam.facing === 'environment' ? 'user' : 'environment'; openCamera(); });
  $('torch-btn').addEventListener('click', async () => {
    const track = S.cam.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() || {};
    if (!caps.torch) return toast('Flash not available on this camera');
    S.cam.torch = !S.cam.torch;
    try { await track.applyConstraints({ advanced: [{ torch: S.cam.torch }] }); toast(`Flash ${S.cam.torch ? 'on' : 'off'}`); } catch { toast('Flash not available'); }
  });
  let shutterBusy = false;
  $('shutter-btn').addEventListener('click', async () => {
    const v = $('camera-feed');
    if (!v.videoWidth || shutterBusy) return;
    shutterBusy = true;
    haptic(35);
    // let the shake from tapping settle before grabbing the frame (matters for small label text)
    if (S.cam.mode === 'label') await new Promise(r => setTimeout(r, 350));
    shutterBusy = false;
    if (!S.cam.stream) return;
    // Crop exactly what is inside the on-screen guide (square for products, 4:3 for labels).
    // getBoundingClientRect includes the digital-zoom scale, so the crop follows the zoom automatically.
    const vr = v.getBoundingClientRect(), gr = $('camera-guide').getBoundingClientRect();
    const k = Math.max(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const offX = (vr.width - v.videoWidth * k) / 2, offY = (vr.height - v.videoHeight * k) / 2;
    let sw = Math.min(gr.width / k, v.videoWidth), sh = Math.min(gr.height / k, v.videoHeight);
    let sx = (gr.left - vr.left - offX) / k, sy = (gr.top - vr.top - offY) / k;
    if (S.cam.facing === 'user') sx = v.videoWidth - sx - sw;
    sx = Math.max(0, Math.min(v.videoWidth - sw, sx)); sy = Math.max(0, Math.min(v.videoHeight - sh, sy));
    const c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    const g = c.getContext('2d');
    if (S.cam.facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    closeCamera();
    if (S.cam.mode === 'label') { await readLabel(c); return; }
    setImage(c);
    await afterNewPhoto();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.cam.stream) closeCamera(); });

  // =====================================================================
  //  EXPORT
  // =====================================================================
  function filename() {
    const parts = [];
    if (S.activeStore >= 0) parts.push(S.stores[S.activeStore].name);
    parts.push(S.title.trim() || 'product');
    const slug = parts.join('_').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'product';
    const t = new Date(); const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
    return `${slug}_${stamp}.png`;
  }
  function exportBlob() {
    render();
    return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/png'));
  }
  async function savePNG() {
    if (!S.work) return toast('Add a photo first');
    haptic(20);
    const blob = await exportBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Saved 1080×1080 PNG');
  }
  async function sharePNG() {
    if (!S.work) return toast('Add a photo first');
    haptic(20);
    const blob = await exportBlob();
    const file = new File([blob], filename(), { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: S.title || '5H13studio' }); }
      catch (err) { if (err.name !== 'AbortError') toast('Share failed'); }
    } else {
      await savePNG();
    }
  }
  $('save-btn').addEventListener('click', savePNG);
  $('share-btn').addEventListener('click', sharePNG);

  // =====================================================================
  //  INSTALL / OFFLINE
  // =====================================================================
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); S.installPrompt = e;
    if (!isStandalone()) { $('install-btn').classList.remove('hidden'); $('install-btn').classList.add('flex'); }
  });
  window.addEventListener('appinstalled', () => { $('install-btn').classList.add('hidden'); $('install-btn').classList.remove('flex'); toast('Installed to home screen'); });
  async function promptInstall() {
    if (S.installPrompt) {
      S.installPrompt.prompt();
      await S.installPrompt.userChoice.catch(() => {});
      S.installPrompt = null;
      $('install-btn').classList.add('hidden'); $('install-btn').classList.remove('flex');
    } else {
      toast(isStandalone() ? 'Already installed' : 'Use your browser menu → Add to Home Screen');
    }
  }
  const openInfo = () => { $('info-modal').classList.remove('hidden'); $('info-modal').classList.add('flex'); };
  const closeInfo = () => { $('info-modal').classList.add('hidden'); $('info-modal').classList.remove('flex'); };
  $('install-btn').addEventListener('click', promptInstall);
  $('install-modal-btn').addEventListener('click', promptInstall);
  $('info-btn').addEventListener('click', openInfo);
  $('info-close-btn').addEventListener('click', closeInfo);
  $('info-modal').addEventListener('click', e => { if (e.target === $('info-modal')) closeInfo(); });
  $('app-version').textContent = APP_VERSION;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { $('sw-status').textContent = 'works offline'; })
      .catch(() => { $('sw-status').textContent = 'online only'; });
  } else {
    $('sw-status').textContent = 'host on HTTPS to install';
  }

  // =====================================================================
  //  BOOT
  // =====================================================================
  async function boot() {
    setTool('move', true);
    syncBackdropUI();
    syncStampUI();
    syncPhotoAdjustUI();
    $('tol-val').textContent = S.tol; $('brush-val').textContent = S.brush + 'px';
    try {
      await Promise.race([
        Promise.all(['800 40px "Bricolage Grotesque"', '500 20px Inter', '600 40px "Playfair Display"', 'italic 500 20px "Playfair Display"', '700 30px "Space Grotesk"'].map(f => document.fonts.load(f))),
        new Promise(r => setTimeout(r, 2500))
      ]);
    } catch {}
    await decodeLogos();
    renderStoreUI();
    await loadDemo('perfume');
    setTab('photo');
  }
  boot();
})();
