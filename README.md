# Tomb Vaider

A third-person web game built with **Three.js r180** and **[Spark 2.0 preview](https://sparkjs.dev/2.0.0-preview/docs/)** (Gaussian splats with level-of-detail). Uses a GLB collider for walking and a splat scene for visuals.

## Controls

- **WASD** or **arrow keys** — Move (camera-relative)
- **Shift** — Run
- **Space** — Jump
- **Q** / **E** — Move up / down (layout and tight spots)
- **Drag on the canvas** — Orbit the follow camera (trackpad-friendly)
- **L** — Toggle pointer lock for mouse look (optional)
- **Scroll / two-finger scroll** — Zoom follow distance
- **G** — Show or hide the lil-gui panel

## Setup

```bash
npm install
npm run dev
```

Open the URL Vite prints (often [http://localhost:3000](http://localhost:3000)).

## Splats: `.RAD` (recommended) vs `.spz`

The app **prefers** `public/ruins-lod.rad` when that file exists (fast Spark 2.0 LoD load). Otherwise it loads `public/ruins.spz` with **`lod: true`** (builds LoD in a background worker; slower first load).

**Pre-build the LoD `.RAD` file** (requires [Rust](https://rust-lang.org/tools/install/)):

```bash
npm run build:rad -- public/ruins.spz --quality
```

That writes **`public/ruins-lod.rad`**. For HTTP streaming with chunk files, add **`--rad-chunked`** to the command and set `splatLoadParams.pagedStreaming = true` in `src/main.js` (see [LoD getting started](https://sparkjs.dev/2.0.0-preview/docs/lod-getting-started/)).

## Assets

- `simplified-mesh.glb` — Collision mesh (invisible; used for ground raycasts)
- `Animations/Laura8.glb` — Rigged character
- `ruins (1).spz` — Source Gaussian splat (**not in Git** if over GitHub’s file limit). Keep it in the **project root** so `public/ruins.spz` can symlink to it, or copy/symlink as you prefer.
- `public/ruins-lod.rad` — Optional; generated locally with `build:rad` (typically not committed if large)
- `Animations/` — Optional FBX fallback animations

The game loads **Laura8 by default**; turn **Show character (Laura8)** off in the panel if you only want to align splats and collider. If the GLB has animations they are used, otherwise it may fall back to FBX.

## Build

```bash
npm run build
```

Output is in `dist/`. Serve the `dist` folder with any static file server.

**GitHub Pages:** `npm run build:pages` (uses base path `/TombVaider/`).
