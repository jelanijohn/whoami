//! Who Am I — Tauri shell.
//!
//! The app is Git-agnostic and storage-agnostic at its Rust core: it simply
//! registers the plugins the TypeScript layer drives.
//!   - plugin-fs    → read/write the canonical `entries/*.md` and `profile.md`
//!   - plugin-sql   → the derived, rebuildable SQLite index (sqlite feature)
//!   - plugin-shell → shell out to the system `git` for the explicit Sync action
//!   - plugin-dialog→ pick the record folder
//!
//! All real logic (the storage contract, indexing, generators, sync) lives in
//! the framework-agnostic TypeScript core, so it stays testable without Tauri.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running Who Am I");
}
