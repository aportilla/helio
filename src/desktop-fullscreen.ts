// Desktop-only (Tauri) fullscreen toggle.
//
// macOS *native* fullscreen (the green button / NSWindow toggleFullScreen) binds
// ESC → exit at the AppKit level, which the web layer can't intercept — so it would
// eat the game's ESC key. Instead the desktop build enters borderless "simple"
// fullscreen (Tauri's set_simple_fullscreen), which doesn't bind ESC. Native entry is
// disabled in tauri.conf.json (maximizable:false), and this binds the toggle key.
//
// No-op in the browser build: the Tauri global is absent, so it returns early, and the
// @tauri-apps/api import is dynamic — it never enters the web bundle.

export function installDesktopFullscreen(): void {
  if (!('__TAURI_INTERNALS__' in window)) return;

  let fullscreen = false;
  window.addEventListener('keydown', (e) => {
    // Option/Alt+Enter — the classic game fullscreen toggle, and free here: the scene's
    // own Enter binding bails when Alt is held.
    if (!e.altKey || (e.code !== 'Enter' && e.code !== 'NumpadEnter')) return;
    e.preventDefault();
    fullscreen = !fullscreen;
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('set_borderless_fullscreen', { enabled: fullscreen }),
    );
  });
}
