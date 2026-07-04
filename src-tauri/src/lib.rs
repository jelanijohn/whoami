//! Who Am I — Tauri shell.
//!
//! The app is Git-agnostic and storage-agnostic at its Rust core: it simply
//! registers the plugins the TypeScript layer drives.
//!   - plugin-fs    → read/write the canonical `entries/*.md` and `profile.md`
//!   - plugin-sql   → the derived, rebuildable SQLite index (sqlite feature)
//!   - plugin-shell → shell out to the system `git` for the explicit Sync action
//!   - plugin-dialog→ pick the record folder
//!   - plugin-http  → CORS-free HTTP to the ingest/LLM APIs (esp. Anthropic)
//!   - plugin-opener→ open the system browser for the Gmail OAuth consent
//!
//! All real logic (the storage contract, indexing, generators, sync) lives in
//! the framework-agnostic TypeScript core, so it stays testable without Tauri.
//! The one exception is `gmail_oauth`: the interactive consent flow needs a
//! loopback TCP listener + the system browser, which a webview cannot do.

//! Secrets: the `Secrets` Platform seam is backed by the OS keyring (macOS
//! Keychain / Windows Credential Manager / Linux Secret Service) via these
//! three app-local commands. Provider tokens (the Anthropic key, the Gmail
//! OAuth client + grant) live here, never in the record repo and never in
//! plaintext on disk — this replaces the interim plaintext `FileSecrets`. App
//! commands like these are not gated by the ACL, so no capability entry is
//! needed.

mod gmail_oauth;

use keyring::{Entry, Error as KeyringError};

/// Keyring service name; the account is the seam's `key` (e.g. `anthropic.api_key`).
const KEYRING_SERVICE: &str = "com.whoami.app";

/// Turn a keyring error into a user-facing message, with a Linux/WSL hint when
/// the platform store itself is missing (the common "no daemon running" case).
fn keyring_error(e: KeyringError) -> String {
    match e {
        KeyringError::NoStorageAccess(_) | KeyringError::PlatformFailure(_) => format!(
            "OS keyring unavailable ({e}). On Linux/WSL a Secret Service daemon \
             (e.g. gnome-keyring) must be running to store secrets."
        ),
        other => other.to_string(),
    }
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key).map_err(keyring_error)
}

/// Read a secret; `Ok(None)` when no entry exists yet. Shared with `gmail_oauth`.
pub(crate) fn get_secret_value(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(keyring_error(e)),
    }
}

pub(crate) fn set_secret_value(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(keyring_error)
}

/// Deleting an absent key is a no-op. Shared with `gmail_oauth`.
pub(crate) fn delete_secret_value(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(keyring_error(e)),
    }
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    get_secret_value(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    set_secret_value(&key, &value)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    delete_secret_value(&key)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|_app| {
            // The custom unified header (Titlebar.svelte) draws the window
            // chrome. macOS keeps its native traffic lights via the Overlay
            // title-bar style (tauri.conf.json); every other platform draws its
            // own min/maximize/close caption buttons, so turn the OS frame off
            // there.
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Manager;
                if let Some(win) = _app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            gmail_oauth::connect_gmail
        ])
        .run(tauri::generate_context!())
        .expect("error while running Who Am I");
}
