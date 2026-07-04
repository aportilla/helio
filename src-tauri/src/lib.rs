#[tauri::command]
fn set_borderless_fullscreen(window: tauri::WebviewWindow, enabled: bool) {
  // macOS native fullscreen (green button) binds ESC → exit at the AppKit level,
  // which the web layer can't intercept — it would eat the game's ESC key. Borderless
  // "simple" fullscreen doesn't bind ESC, so the game keeps it. Driven from the web
  // keydown handler (src/desktop-fullscreen.ts); native entry is disabled in
  // tauri.conf.json (maximizable:false), since set_simple_fullscreen no-ops while a
  // window is in native fullscreen.
  let _ = window.set_simple_fullscreen(enabled);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![set_borderless_fullscreen])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
