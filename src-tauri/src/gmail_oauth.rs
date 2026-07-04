//! Gmail OAuth — the interactive desktop loopback + PKCE consent flow.
//!
//! Ported from waid's `connect_gmail` (commands.rs). This is the ONE piece of
//! Gmail auth that must live in Rust: it needs a loopback TCP listener for the
//! OAuth redirect and the system browser for consent, neither of which the
//! webview can do. Everything else — token refresh, grant freshness, the
//! keyring key layout — lives in the TypeScript core
//! (`src/lib/core/ingest/gmail-oauth.ts`) over the Http + Secrets seams, where
//! it is unit-tested. Keep the grant JSON shape in sync with that module.
//!
//! Bring-your-own client: the user creates a Google *Desktop* OAuth client and
//! saves its id + secret via the Secrets seam. Who Am I ships no shared Google
//! credentials. Only ever writes to the keyring — never the record repo.

use std::time::Duration;

use crate::{delete_secret_value, get_secret_value, set_secret_value};

/// Keyring keys — must match `src/lib/core/ingest/gmail-oauth.ts`.
const SECRET_GMAIL_CLIENT_ID: &str = "gmail.client_id";
const SECRET_GMAIL_CLIENT_SECRET: &str = "gmail.client_secret";
/// The stored grant: JSON `{email, refresh_token, access_token, expires_at}`.
const GMAIL_GRANT_KEY: &str = "gmail.oauth";
/// The pre-OAuth pasted-access-token key — deleted on connect so stale entries
/// don't linger in the OS keyring.
const LEGACY_GMAIL_TOKEN_KEY: &str = "gmail.access_token";

const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";

/// Best-effort detection of a WSL environment (waid's `is_wsl`): under WSL the
/// browser opens on the Windows host, so the loopback bind must differ.
fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        return true;
    }
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| {
            let s = s.to_lowercase();
            s.contains("microsoft") || s.contains("wsl")
        })
        .unwrap_or(false)
}

fn http_client(connect_secs: u64, total_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_secs))
        .timeout(Duration::from_secs(total_secs))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

/// base64url-without-padding, used for the PKCE verifier/challenge and `state`.
fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 bytes of OS entropy as base64url (43 chars). Used for the PKCE verifier
/// and the CSRF `state`.
fn random_b64url() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("could not gather entropy: {e}"))?;
    Ok(b64url(&buf))
}

/// PKCE pair: a high-entropy `code_verifier` and its `S256` `code_challenge`.
fn pkce_pair() -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    let verifier = random_b64url()?;
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// Compute the stored `expires_at` from an `expires_in` (seconds), trimming a
/// small skew so the TS refresh path renews slightly early.
fn gmail_expires_at(now: chrono::DateTime<chrono::Utc>, expires_in_secs: i64) -> String {
    let skew = 30;
    (now + chrono::Duration::seconds((expires_in_secs - skew).max(0)))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Read the user's bring-your-own Google OAuth client (id + secret) from the
/// keyring, erroring with a setup hint when either is missing.
fn gmail_oauth_client() -> Result<(String, String), String> {
    let id = get_secret_value(SECRET_GMAIL_CLIENT_ID)?
        .filter(|s| !s.trim().is_empty())
        .ok_or("Add your Google OAuth client (ID + secret) on the Import page first.")?;
    let secret = get_secret_value(SECRET_GMAIL_CLIENT_SECRET)?
        .filter(|s| !s.trim().is_empty())
        .ok_or("Add your Google OAuth client (ID + secret) on the Import page first.")?;
    Ok((id, secret))
}

/// Run the Google OAuth desktop loopback flow and store the resulting grant
/// (with the discovered account email) under `gmail.oauth`. Returns the email
/// so the frontend can show "Connected as …". Requires the Gmail
/// client_id/secret to be saved first. Only ever writes to the keyring.
#[tauri::command]
pub async fn connect_gmail(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (client_id, client_secret) = gmail_oauth_client()?;
    let (verifier, challenge) = pkce_pair()?;
    let state = random_b64url()?;

    // Loopback redirect: bind an ephemeral port; Desktop OAuth clients auto-allow
    // `http://127.0.0.1:<any-port>`, so there's no redirect URI to register.
    //
    // Under WSL the browser opens on the Windows host, so Google's redirect to
    // `127.0.0.1` arrives via WSL2's localhost-forwarding relay, which forwards
    // into the VM's eth0 address — a `127.0.0.1`-only socket would never see it.
    // Bind `0.0.0.0` there so the forwarded connection lands. The `redirect_uri`
    // stays `127.0.0.1` regardless (Google only allows loopback hosts, and it's
    // just a matched string at token exchange — never connected to). PKCE + the
    // unguessable `state` keep the briefly-LAN-reachable port safe. On every
    // other platform we keep the tighter loopback-only bind.
    let bind_addr = if is_wsl() { "0.0.0.0:0" } else { "127.0.0.1:0" };
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("could not start loopback listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", GMAIL_SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            // offline + consent guarantee a refresh_token on first consent.
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| format!("could not build auth URL: {e}"))?;

    app.opener()
        .open_url(auth_url.to_string(), None::<&str>)
        .map_err(|e| format!("could not open browser: {e}"))?;

    // Wait for the single loopback redirect (bounded so an abandoned consent
    // can't hang the command forever).
    let (mut sock, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| "Timed out waiting for Google sign-in.".to_string())?
        .map_err(|e| format!("loopback accept failed: {e}"))?;

    let mut buf = vec![0u8; 8192];
    let n = sock
        .read(&mut buf)
        .await
        .map_err(|e| format!("could not read redirect: {e}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    // First line: "GET /?code=...&state=... HTTP/1.1".
    let target = request
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let redirect = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|e| format!("malformed redirect: {e}"))?;
    let params: std::collections::HashMap<String, String> =
        redirect.query_pairs().into_owned().collect();

    // Always answer the browser so the tab doesn't hang, then drop the socket.
    let page = "<!doctype html><html><body style=\"font-family:system-ui;padding:3rem;text-align:center\">\
        <h2>Connected ✓</h2><p>You can close this tab and return to Who Am I.</p></body></html>";
    let http = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        page.len(),
        page
    );
    let _ = sock.write_all(http.as_bytes()).await;
    let _ = sock.flush().await;
    drop(sock);
    drop(listener);

    if let Some(err) = params.get("error") {
        return Err(format!("Google sign-in was declined ({err})."));
    }
    if params.get("state").map(String::as_str) != Some(state.as_str()) {
        return Err("Gmail sign-in failed a security check (state mismatch). Try again.".into());
    }
    let code = params
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or("Google sign-in returned no authorization code.")?;

    // Exchange the code for tokens.
    let client = http_client(5, 20)?;
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid token response: {e}"))?;
    if !status.is_success() {
        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or_default();
        return Err(format!("Gmail token exchange failed ({status}): {err}"));
    }
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("token response missing access_token")?
        .to_string();
    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .ok_or(
            "Google didn't return a refresh token. Ensure the OAuth consent screen is set to \
            \"In production\" and try again.",
        )?
        .to_string();
    let expires_in = json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);

    // Discover the account email (works with gmail.readonly — no userinfo scope).
    let profile = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("could not read Gmail profile: {e}"))?;
    let profile_status = profile.status();
    let profile: serde_json::Value = profile
        .json()
        .await
        .map_err(|e| format!("invalid Gmail profile response: {e}"))?;
    if !profile_status.is_success() {
        return Err(format!("Gmail profile request failed ({profile_status})"));
    }
    let email = profile
        .get("emailAddress")
        .and_then(|v| v.as_str())
        .filter(|e| !e.is_empty())
        .ok_or("Gmail profile had no email address")?
        .to_string();

    let grant = serde_json::json!({
        "email": email,
        "refresh_token": refresh_token,
        "access_token": access_token,
        "expires_at": gmail_expires_at(chrono::Utc::now(), expires_in),
    });
    set_secret_value(GMAIL_GRANT_KEY, &grant.to_string())?;
    // The old pasted-token key is obsolete — clear it so it can't linger.
    let _ = delete_secret_value(LEGACY_GMAIL_TOKEN_KEY);
    Ok(email)
}
