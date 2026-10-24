# 5H13studio — 1:1 Product Studio

Installable web app for square (1080×1080) product photos for online stores:
background removal (small AI model on the phone, with a simple colour remover for plain backgrounds), per-store logo overlays, box-label text reading (OCR), 5H13 brand stamp and backdrops, PNG export/share.

**Live app:** https://5h13.github.io/studio/

## Install on a phone
- **iPhone / iPad:** open the link in Safari → Share → *Add to Home Screen*
- **Android:** open in Chrome → *Install app* (or the Install button in the app)

Works offline after the first visit. The AI background remover downloads its files (`ai/`, ~15 MB) the first time it is used; text reading downloads its engine (~5 MB) the first time it is used. Both are then kept for offline use.

## Licences
AI remover: U²-Net small (Apache-2.0) and ONNX Runtime Web (MIT) — see `ai/LICENSES.txt`.

## Deploying (GitHub Pages)
Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
All paths are relative, so it runs from `/studio/` as-is. `.nojekyll` skips Jekyll processing.

## Updating
After changing files, bump `VERSION` at the top of `sw.js` so installed phones pick up the new version.

## Play Store
Paste the live URL into [PWABuilder](https://www.pwabuilder.com) → Package for stores → Android.
