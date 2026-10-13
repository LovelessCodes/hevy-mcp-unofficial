# hevy-mcp

MCP server for Hevy — covers the **Hevy Trainer** endpoints, **Hevy Coach** endpoints, the
**mobile app private API**, and the **public `/v1` API**. Built from the reverse-engineering
artifacts in `../notes` and `../recon`.

> Unofficial, community project. Not affiliated with or endorsed by Hevy. Uses reverse-engineered
> private endpoints that may change without notice; use at your own risk and respect Hevy's terms.

## Coverage

328 discovered endpoints, in `src/endpoints.json`:

| group | count | source |
|---|---|---|
| trainer | 9 | verified live against `api.hevyapp.com` |
| coach | 124 | `app.hevycoach.com` web client extraction |
| mobile | 179 | Hevy Android v3.2.0 Hermes disassembly |
| public | 16 | official `/v1` docs |

59 curated tools are exposed by default; `HEVY_TOOLS=all` exposes every endpoint
pattern as an individual tool. Everything is always reachable through the
generic `hevy_request` tool and searchable via `hevy_search_endpoints`
(resource: `hevy://endpoints`).

## Auth

Two schemes, auto-routed per path:

- **Session API** (Trainer, Coach, `/v2/*`, mobile private): header
  `x-api-key: shelobs_hevy_web` + `Authorization: Bearer <access token>`
  (auto-refreshed via `POST /auth/refresh_token` when a refresh token is available)
- **Public API** (`/v1/*`): header `api-key: <hevy-pro-api-key>`

Recommended setup — save the hevy.com `auth2.0-token` cookie (DevTools →
Application → Cookies → copy its JSON value) to `~/.config/hevy/auth.json`:

```json
{"access_token": "...", "refresh_token": "...", "expires_at": "..."}
```

The server reads it, keeps the session alive automatically, and writes refreshed
tokens back to the same file (mode 600).

Alternative (no auto-refresh): access token in `~/.config/hevy/session_token`
(= hevy.com `access-token` cookie) and optionally the refresh token in
`~/.config/hevy/refresh_token`.

| env | file (default) | contents |
|---|---|---|
| `HEVY_AUTH_JSON` / `HEVY_AUTH_JSON_FILE` | `~/.config/hevy/auth.json` | access + refresh + expiry |
| `HEVY_SESSION_TOKEN` / `HEVY_SESSION_TOKEN_FILE` | `~/.config/hevy/session_token` | access token |
| `HEVY_REFRESH_TOKEN` / `HEVY_REFRESH_TOKEN_FILE` | `~/.config/hevy/refresh_token` | refresh token |
| `HEVY_API_KEY` / `HEVY_API_KEY_FILE` | `~/.config/hevy/api_key` | public API key |
| `HEVY_API_BASE` | — | default `https://api.hevyapp.com` |
| `HEVY_WEB_API_KEY` | — | default `shelobs_hevy_web` |
| `HEVY_TOOLS` | — | set to `all` to expose every endpoint as a tool |

## Run

Quick start via npx (no clone needed):

```bash
npx -y hevy-mcp-unofficial
```

From source:

```bash
npm install
node src/server.js          # stdio MCP server
npm run smoke               # live read-only smoke test
```

MCP client config (opencode / Claude Desktop style):

```json
{
  "mcp": {
    "hevy-private": {
      "type": "local",
      "command": ["npx", "-y", "hevy-mcp-unofficial"],
      "enabled": true
    }
  }
}
```

## Tool groups

- `hevy_trainer_*` — get/create/update/delete program, migrate v3, preferences
- `hevy_coach_*` — clients, programs, routines, team, leads, chat, billing
- `hevy_*` — account, workouts, body measurements, key-values
- `hevy_request` — raw call to any discovered endpoint (method/path/query/body)
- `hevy_search_endpoints` — search the inventory by path/name/group

Write tools are annotated (`readOnlyHint` / `destructiveHint`); destructive ones act on
real account data.

## Regenerating the inventory

```bash
npm run build:endpoints
```

Reads `recon/web/coach_api_full.txt`, `src/endpoints_mobile.json` (produced from
`notes/hevy_bundle.hasm` via Hermes disassembly) and the hand-curated trainer/public lists.
