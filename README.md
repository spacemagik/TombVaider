# Tomb Vaider

A third-person web game built with Three.js. Explore with your character using keyboard and mouse controls.

## Controls

- **WASD** — Move
- **Shift** — Run
- **Space** — Jump
- **Click** — Lock mouse for camera look (press ESC to unlock)

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Assets

- `simplified-mesh.glb` — Collision mesh (invisible; used for ground raycasts)
- `Animations/Laura8.glb` — Rigged character
- `ruins (1).spz` — Gaussian splat scene (**not in Git**; over GitHub’s 100MB file limit). Place this file in the **project root** next to `package.json` so `public/ruins.spz` can resolve it, or use [Git LFS](https://git-lfs.github.com/) if you need it versioned remotely.
- `Animations/` — Optional FBX fallback animations

The game loads Laura8; if the GLB has animations they are used, otherwise it may fall back to FBX.

## Build

```bash
npm run build
```

Output is in `dist/`. Serve the `dist` folder with any static file server.
