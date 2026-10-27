#!/usr/bin/env python3
from pathlib import Path
import shutil, sys, re

VERSION = '1.8.0'

def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f'{label}: expected 1 anchor, found {n}')
    return text.replace(old, new, 1)

def patch_app(text):
    text = re.sub(r"const APP_VERSION = '[^']+';", f"const APP_VERSION = '{VERSION}';", text, count=1)
    state_anchor = "    x: SIZE / 2, y: SIZE / 2, scale: 1, rot: 0,\n"
    state_new = state_anchor + "    brightness: 0, contrast: 0, saturation: 0, exposure: 0,\n    crop: { x: 0, y: 0, w: 100, h: 100 },\n"
    text = replace_once(text, state_anchor, state_new, 'adjustment state')

    reset_anchor = "    S.undo = []; updateUndo();\n    S.lastOpAuto = false;\n"
    reset_new = "    S.undo = []; updateUndo();\n    S.lastOpAuto = false;\n    S.brightness = S.contrast = S.saturation = S.exposure = 0;\n    S.crop = { x: 0, y: 0, w: 100, h: 100 };\n    syncPhotoAdjustUI?.();\n"
    text = replace_once(text, reset_anchor, reset_new, 'new photo reset')

    render_anchor = "      target.scale(S.scale, S.scale);\n      target.drawImage(S.work, -S.work.width / 2, -S.work.height / 2);\n      target.restore();"
    render_new = "      target.scale(S.scale, S.scale);\n      const cr = cropRect();\n      const exp = Math.pow(2, S.exposure);\n      target.filter = `brightness(${Math.max(0, (100 + S.brightness) * exp)}%) contrast(${100 + S.contrast}%) saturate(${100 + S.saturation}%)`;\n      target.drawImage(S.work, cr.x, cr.y, cr.w, cr.h, -cr.w / 2, -cr.h / 2, cr.w, cr.h);\n      target.filter = 'none';\n      target.restore();"
    text = replace_once(text, render_anchor, render_new, 'render pipeline')

    adjust_anchor = "  // ---------- Adjust panel ----------\n"
    adjust_code = r'''  // ---------- Photo corrections and crop ----------
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
'''
    text = replace_once(text, adjust_anchor, adjust_code + adjust_anchor, 'adjust handlers')

    boot_anchor = "    syncStampUI();\n"
    text = replace_once(text, boot_anchor, boot_anchor + "    syncPhotoAdjustUI();\n", 'boot sync')
    return text

def patch_html(text):
    old = '''    <div class="tab-panel space-y-3" data-panel="adjust">\n      <div class="space-y-1">\n        <div class="row"><span>Size</span><span id="scale-val" class="val">100%</span></div>'''
    new = '''    <div class="tab-panel space-y-3" data-panel="adjust">\n      <span class="sec block">Photo correction</span>\n      <div class="grid grid-cols-2 gap-2">\n        <div class="space-y-1"><div class="row"><span>Brightness</span><span id="brightness-val" class="val">0</span></div><input type="range" id="brightness-input" min="-100" max="100" value="0" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Contrast</span><span id="contrast-val" class="val">0</span></div><input type="range" id="contrast-input" min="-100" max="100" value="0" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Saturation</span><span id="saturation-val" class="val">0</span></div><input type="range" id="saturation-input" min="-100" max="100" value="0" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Exposure</span><span id="exposure-val" class="val">0.0</span></div><input type="range" id="exposure-input" min="-2" max="2" step="0.1" value="0" class="slider" /></div>\n      </div>\n      <button id="reset-photo-adjust-btn" class="btn w-full">Reset photo corrections</button>\n      <span class="sec block">Crop</span>\n      <div class="grid grid-cols-2 gap-2">\n        <div class="space-y-1"><div class="row"><span>Left</span><span id="crop-x-val" class="val">0%</span></div><input type="range" id="crop-x-input" min="0" max="90" value="0" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Top</span><span id="crop-y-val" class="val">0%</span></div><input type="range" id="crop-y-input" min="0" max="90" value="0" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Width</span><span id="crop-w-val" class="val">100%</span></div><input type="range" id="crop-w-input" min="10" max="100" value="100" class="slider" /></div>\n        <div class="space-y-1"><div class="row"><span>Height</span><span id="crop-h-val" class="val">100%</span></div><input type="range" id="crop-h-input" min="10" max="100" value="100" class="slider" /></div>\n      </div>\n      <div class="grid grid-cols-3 gap-2"><button id="crop-square-btn" class="btn">Square</button><button id="crop-reset-btn" class="btn">Reset crop</button><button id="apply-crop-btn" class="btn-primary">Apply crop</button></div>\n      <span class="sec block">Position</span>\n      <div class="space-y-1">\n        <div class="row"><span>Size</span><span id="scale-val" class="val">100%</span></div>'''
    return replace_once(text, old, new, 'adjust panel')

def patch_sw(text):
    return re.sub(r"const VERSION = '[^']+';", f"const VERSION = '{VERSION}';", text, count=1)

def patch_readme(text):
    old = 'background removal (small AI model on the phone, with a simple colour remover for plain backgrounds), per-store logo overlays, box-label text reading (OCR), 5H13 brand stamp and backdrops, PNG export/share.'
    new = 'background removal (small AI model on the phone, with a simple colour remover for plain backgrounds), crop, brightness, contrast, saturation and exposure controls, per-store logo overlays, box-label text reading (OCR), 5H13 brand stamp and backdrops, PNG export/share.'
    return replace_once(text, old, new, 'README feature list')

def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    needed = ['app.js', 'index.html', 'sw.js', 'README.md']
    missing = [n for n in needed if not (root / n).is_file()]
    if missing: raise SystemExit('Missing in target folder: ' + ', '.join(missing))
    backup = root / 'backup-v1.7.0'
    backup.mkdir(exist_ok=True)
    for n in needed: shutil.copy2(root / n, backup / n)
    patches = {'app.js': patch_app, 'index.html': patch_html, 'sw.js': patch_sw, 'README.md': patch_readme}
    for n, fn in patches.items():
        p = root / n
        updated = fn(p.read_text(encoding='utf-8'))
        p.write_text(updated, encoding='utf-8', newline='\n')
    print(f'5H13studio updated to v{VERSION}. Backup: {backup}')

if __name__ == '__main__': main()
