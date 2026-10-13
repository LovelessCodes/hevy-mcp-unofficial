// Hevy API client: routes requests to the right auth scheme and auto-refreshes sessions.
//  - /v1/*            -> public API, `api-key` header
//  - everything else  -> session API, `x-api-key: shelobs_hevy_web` + `Authorization: Bearer <access token>`
//
// Session auth sources (first match wins):
//   1. HEVY_AUTH_JSON / ~/.config/hevy/auth.json  {"access_token","refresh_token","expires_at"}  (the auth2.0-token cookie)
//   2. HEVY_SESSION_TOKEN / ~/.config/hevy/session_token           (access token only)
//      HEVY_REFRESH_TOKEN / ~/.config/hevy/refresh_token           (enables auto-refresh)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_BASE = process.env.HEVY_API_BASE || "https://api.hevyapp.com";
const WEB_API_KEY = process.env.HEVY_WEB_API_KEY || "shelobs_hevy_web";
const APP_VERSION = process.env.HEVY_APP_VERSION || "3.2.0";

const CONFIG_DIR = path.join(os.homedir(), ".config/hevy");
const FILES = {
  authJson: process.env.HEVY_AUTH_JSON_FILE || path.join(CONFIG_DIR, "auth.json"),
  session: process.env.HEVY_SESSION_TOKEN_FILE || path.join(CONFIG_DIR, "session_token"),
  refresh: process.env.HEVY_REFRESH_TOKEN_FILE || path.join(CONFIG_DIR, "refresh_token"),
  apiKey: process.env.HEVY_API_KEY_FILE || path.join(CONFIG_DIR, "api_key"),
};

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const state = { access: null, refresh: null, expiresAt: null, loaded: false, refreshInFlight: null };

function loadAuth(force = false) {
  if (state.loaded && !force) return state;
  const envAccess = process.env.HEVY_SESSION_TOKEN || null;
  const envRefresh = process.env.HEVY_REFRESH_TOKEN || null;
  const authJson = readJsonSafe(FILES.authJson);
  state.access = envAccess || authJson?.access_token || readFileSafe(FILES.session);
  state.refresh = envRefresh || authJson?.refresh_token || readFileSafe(FILES.refresh);
  state.expiresAt = authJson?.expires_at || null;
  state.loaded = true;
  return state;
}

export function getApiKey() {
  return process.env.HEVY_API_KEY || readFileSafe(FILES.apiKey);
}

export function authStatus() {
  const a = loadAuth();
  return {
    accessToken: a.access ? `present (${a.access.length} chars${a.expiresAt ? `, expires_at: ${a.expiresAt}` : ", exp: opaque"})` : "missing",
    refreshToken: a.refresh ? `present (${a.refresh.length} chars)` : "missing (auto-refresh disabled)",
    apiKey: getApiKey() ? "present" : "missing",
    apiBase: API_BASE,
    files: FILES,
  };
}

function persistAuth() {
  // best-effort write-back so restarts use the freshest tokens
  const tryWrite = (p, v) => {
    try {
      fs.writeFileSync(p, v, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (process.env.HEVY_SESSION_TOKEN) return; // env overrides files; never touch files in that mode
  if (fs.existsSync(FILES.authJson) && state.access) {
    tryWrite(FILES.authJson, JSON.stringify({ access_token: state.access, refresh_token: state.refresh, expires_at: state.expiresAt }));
  } else if (state.access) {
    tryWrite(FILES.session, state.access);
    if (state.refresh) tryWrite(FILES.refresh, state.refresh);
  }
}

async function refreshAccessToken() {
  if (!state.refresh) {
    throw new Error("Session expired and no refresh token configured (set HEVY_REFRESH_TOKEN or ~/.config/hevy/refresh_token)");
  }
  const res = await fetch(new URL("/auth/refresh_token", API_BASE), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": WEB_API_KEY,
      ...(state.access ? { authorization: `Bearer ${state.access}` } : {}),
      "x-client-time": String(Date.now() / 1000),
    },
    body: JSON.stringify({ refresh_token: state.refresh }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(`Token refresh failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  state.access = data.access_token;
  if (data.refresh_token) state.refresh = data.refresh_token;
  if (data.expires_at) state.expiresAt = data.expires_at;
  persistAuth();
  return state.access;
}

export async function refreshSession() {
  await refreshAccessToken();
  return authStatus();
}

function buildPath(template, pathParams = {}) {
  let p = template;
  for (const [k, v] of Object.entries(pathParams)) {
    p = p.replaceAll(`{${k}}`, encodeURIComponent(String(v)));
  }
  const missing = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (missing.length) throw new Error(`Missing path params: ${missing.join(", ")}`);
  return p;
}

export async function hevyRequest({ method = "GET", path: p, query, body, pathParams, headers = {}, allow404 = false, _retried = false }) {
  const fullPath = buildPath(p, pathParams);
  const url = new URL(fullPath, API_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const isPublic = fullPath.startsWith("/v1/");
  const h = { accept: "application/json", ...headers };
  if (isPublic) {
    const key = getApiKey();
    if (!key) throw new Error("Public API key missing. Set HEVY_API_KEY or ~/.config/hevy/api_key");
    h["api-key"] = key;
  } else {
    const auth = loadAuth();
    if (!auth.access) throw new Error("Session token missing. Set HEVY_SESSION_TOKEN, ~/.config/hevy/session_token, or ~/.config/hevy/auth.json");
    h["x-api-key"] = WEB_API_KEY;
    h["Authorization"] = `Bearer ${auth.access}`;
    h["Hevy-App-Version"] = APP_VERSION;
    h["x-client-time"] = String(Date.now() / 1000);
  }
  if (body !== undefined) h["content-type"] = "application/json";

  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  // expired session -> refresh once and retry
  if (res.status === 401 && !isPublic && !_retried && data && typeof data === "object" && data.error === "AccessTokenExpired") {
    state.refreshInFlight = state.refreshInFlight || refreshAccessToken().finally(() => { state.refreshInFlight = null; });
    await state.refreshInFlight;
    return hevyRequest({ method, path: p, query, body, pathParams, headers, allow404, _retried: true });
  }

  if (!res.ok) {
    if (allow404 && res.status === 404) return { status: 404, data: null };
    const err = new Error(`${method} ${url.pathname} -> HTTP ${res.status}${typeof data === "string" ? `: ${data.slice(0, 300)}` : `: ${JSON.stringify(data).slice(0, 300)}`}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}
