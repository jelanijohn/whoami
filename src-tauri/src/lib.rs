//! Who Am I — Tauri shell.
//!
//! The app is Git-agnostic and storage-agnostic at its Rust core: it simply
//! registers the plugins the TypeScript layer drives.
//!   - plugin-fs    → read/write the canonical `entries/*.md` and `profile.md`
//!   - plugin-sql   → the derived, rebuildable SQLite index (sqlite feature)
//!   - plugin-shell → shell out to the system `git` for the explicit Sync action
//!   - plugin-dialog→ pick the record folder
//!   - plugin-http  → CORS-free HTTP to the ingest/LLM APIs (esp. Anthropic)
//!
//! All real logic (the storage contract, indexing, generators, sync) lives in
//! the framework-agnostic TypeScript core, so it stays testable without Tauri.

//! Secrets: the `Secrets` Platform seam is backed by the OS keyring (macOS
//! Keychain / Windows Credential Manager / Linux Secret Service) via these
//! three app-local commands. Provider tokens (the Anthropic key, future OAuth
//! tokens) live here, never in the record repo and never in plaintext on disk —
//! this replaces the interim plaintext `FileSecrets`. App commands like these
//! are not gated by the ACL, so no capability entry is needed.

use keyring::{Entry, Error as KeyringError};

/// Keyring service name; the account is the seam's `key` (e.g. `anthropic.api_key`).
const KEYRING_SERVICE: &str = "com.whoami.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()), // deleting an absent key is a no-op
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Who Am I");
}
