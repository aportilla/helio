# Desktop shell (Tauri)

The native **macOS desktop build** of Helio — a thin [Tauri v2](https://tauri.app)
shell that wraps the *exact same* web build in a system WKWebView window. No app
code, scene, or `vite.config.ts` change: the browser build under `src/` stays the
single source of truth, and this directory only adds the native window, lifecycle,
and packaging around it.

Tauri (not Electron) because it uses the OS webview — WebKit on macOS — so the
bundle is a few MB and the renderer is the same Metal-backed WebGL2 as Safari,
rather than shipping a whole Chromium.

## Two build paths — the load-bearing split

The web deploy and the desktop app serve the frontend from **different origins**,
so they need different asset bases:

- **Web / GitHub Pages** — served under `/helio/`, so `vite.config.ts` pins
  `base: '/helio/'`. Nothing here touches that path.
- **Desktop** — the webview serves the frontend from its origin **root**, not
  `/helio/`. So the desktop build overrides the base to **relative**
  (`vite build --base=./`, wrapped as the `build:tauri` npm script). Relative
  asset URLs resolve whether the frontend loads over the dev server or Tauri's
  custom scheme.

Keeping the override in `build:tauri` — never in `vite.config.ts` — is what lets
both targets build from the same sources without stepping on each other. Editing
`vite.config.ts`'s `base` would silently break one of them.

## Dev vs packaged: two webview modes

`tauri.conf.json` wires both:

- **`npm run tauri:dev`** — runs `beforeDevCommand` (`npm run dev`, the Vite dev
  server) and points the window at that `devUrl` over **http**. First launch
  compiles the Rust deps (one-time); after that it's seconds. Webview devtools are
  on — right-click → Inspect.
- **`npm run tauri:build`** — runs `build:tauri` (relative-base production build
  into `dist/`), then bundles a native `.app` / `.dmg` that serves `frontendDist`
  over Tauri's **custom scheme**.

## Rendering notes (WebKit)

Two WebKit facts bear on Helio's pixel-crisp + exact-sRGB commitments (see
[the scene doc](../src/scene/README.md)):

- **devicePixelRatio caveat.** WKWebView reports `devicePixelRatio = 1` on Retina
  when the frontend is served over a **custom scheme** (the packaged build), but
  the correct `2` over **http** (the dev build). Because the nearest-neighbor
  upscale is DPR-dependent, verify pixel scaling on a *packaged* build — the
  `tauri:dev` path can look perfect while the packaged path still needs the DPR
  handled. This is the main open item before release.
- **Colour is safe — arguably better.** WebKit colour-manages sRGB to the display
  and does **not** auto-promote canvas/WebGL to Display-P3 unless asked. So the
  exact-hex / `ColorManagement`-off intent renders true sRGB, if anything more
  faithfully than a non-colour-managed browser on a wide-gamut Mac.

## What's here

Standard Tauri v2 layout — the Rust side is boilerplate; the app is all web:

```
Cargo.toml            Rust crate + Tauri deps
tauri.conf.json       Window (opaque bg matching --bg, background-throttling off),
                      build wiring, bundle identifier
build.rs              Tauri build script (boilerplate)
src/main.rs, lib.rs   Entry point (boilerplate — no custom native code yet)
capabilities/         Default capability set
icons/                Placeholder Tauri icons — swap for a Helio icon before release
```

`target/` (Rust build cache) and `gen/schemas` stay untracked via this directory's
own `.gitignore`.

## Prerequisites

The Rust toolchain (`cargo`) — `brew install rust`, or [rustup](https://rustup.rs).
Everything else (Node, Xcode Command Line Tools) the web build already needs.
