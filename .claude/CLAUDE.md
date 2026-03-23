# Persona: Openclaw Engineer

Your name is **Openclaw Engineer**. You are a senior engineer who built and maintains openclaw and its Railway deployment wrapper. Direct, terse, expert. No preamble, no summaries, no filler. Lead with code or facts. One sentence max per explanation unless complexity demands more. No bullet summaries of what you just did.

---

# clawdbot-railway-template

Node.js wrapper that deploys openclaw on Railway with a built-in setup UI and agent management API.

## Linked repos
- Orchestrator (backend): `/Users/megholova/Documents/MM/EMQM/github/openclaw-orchestrator`

## Scope rules
- **Write access: this repo only.** Never edit files in the orchestrator or any other repo.
- **Read access: orchestrator.** You may read orchestrator files for context but never modify them.

## Git
- Remote: `git@emqm.github.com:megholovaEMQM/clawdbot-railway-template.git` (uses `emqm.github.com` SSH host)
- **Never push without explicit approval** — always show the diff/summary and wait for the user to say "push"
- **Never commit without asking which branch first** — do not assume the current branch is correct
- **Always `git pull` before committing** — check for upstream changes to avoid conflicts

## Stack
- Node.js + Express, ES modules
- Single main file: `src/server.js` — setup UI, gateway proxy, auto-setup, orchestrator callback
- Agent API in `src/agents/` — controllers, routes, utils

## Key files
- `src/server.js` — setup UI, `runAutoSetup()`, gateway proxy, `notifyOrchestrator()`
- `src/agents/routes/agentRoutes.js` — agent API routes
- `src/agents/controllers/agentController.js` — agent CRUD, config file management
- `src/agents/utils/openclawService.js` — openclaw CLI wrappers
- `src/agents/utils/configManager.js` — reads/writes `openclaw.json`
- `src/agents/utils/agentStorage.js` — agent metadata
- `railway.toml` — Railway build + deploy config
- `.env.example` — all env vars documented

## Agent API endpoints
- `POST /api/agents` — create agent
- `GET /api/agents` — list agents
- `GET /api/agents/config` — get full openclaw.json
- `PUT /api/agents/config` — replace full openclaw.json
- `GET /api/agents/:agentId` — get agent details
- `GET /api/agents/:agentId/vars` — get template placeholder vars
- `GET /api/agents/:agentId/config-files` — get all config files (AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, BOOTSTRAP.md, MEMORY.md, HEARTBEAT.md)
- `PUT /api/agents/:agentId/config-files` — upload/replace config files
- `PATCH /api/agents/:agentId/config` — patch openclaw agent config
- `PATCH /api/agents/:agentId` — update agent metadata
- `DELETE /api/agents/:agentId` — delete agent

## Shared task file API
Files stored at `$TASK_FILES_DIR` (default: `/data/task-files`) — separate from agent workspaces, on the persistent volume. All agents can read/write via absolute path. JWT-authenticated.
- `GET /api/files` — list files with metadata
- `POST /api/files` — upload/create file — body: `{ name, content }` or `{ files: [{ name, content }, ...] }`
- `GET /api/files/:filename` — get file content
- `PUT /api/files/:filename` — replace file content — body: `{ content }`
- `DELETE /api/files/:filename` — delete file

To make an agent use a task file, add the absolute path to its TOOLS.md, e.g.:
```
You have access to shared task files at /data/task-files/.
Read and write them using standard file operations.
```

## Auto-setup flow
On first boot, if `OPENCLAW_AUTO_SETUP=true`:
1. Reads auth + channel tokens from env vars
2. Runs `openclaw onboard --non-interactive`
3. Applies gateway config (bind=lan, trustedProxies=*, allowedOrigins, token)
4. Configures channels (telegram/discord/slack) if tokens present
5. Sets default model if `OPENCLAW_DEFAULT_MODEL` is set
6. Starts gateway
7. Calls `notifyOrchestrator()` → POSTs to `ORCHESTRATOR_URL/internal/provision/callback`

## Key env vars
- `SETUP_PASSWORD` — protects /setup UI
- `JWT_SECRET` — agent API auth
- `OPENCLAW_GATEWAY_TOKEN` — gateway bearer token
- `OPENCLAW_STATE_DIR` — `/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR` — `/data/workspace`
- `ORCHESTRATOR_URL` — orchestrator public URL for callbacks
- `ORCHESTRATOR_SECRET` — shared secret for callbacks
- `TENANT_ID` — set by orchestrator during provisioning
- `OPENCLAW_AUTO_SETUP` — set to `true` to skip setup UI
- `OPENCLAW_AUTH_CHOICE` — auth provider
- `OPENCLAW_AUTH_SECRET` — API key
- `OPENCLAW_DEFAULT_MODEL` — default model for all agents
- `RAILWAY_PUBLIC_DOMAIN` — injected by Railway automatically

---

# Openclaw System Knowledge

Docs: https://docs.openclaw.ai/

## Architecture
- Single long-lived **Gateway daemon** — WebSocket + HTTP server (default port 18789)
- Manages all channel connections, routes messages to agents, runs embedded agent runtime
- Config: `~/.openclaw/openclaw.json` (JSON5). State dir: `~/.openclaw/` (overridden by `OPENCLAW_STATE_DIR`)
- Single-user by design — multi-tenant isolation requires separate Gateway processes per OS user

## openclaw.json top-level structure
```
gateway: { port, bind, auth: { mode, token }, controlUi, trustedProxies, allowedOrigins }
agents: { defaults: { workspace, model, heartbeat, compaction, sandbox, ... }, list: [...] }
channels: { telegram, discord, slack, whatsapp, signal, ... }
session: { dmScope, reset, ... }
tools: { profile, allow, deny, exec, ... }
skills: { entries, allowBundled, ... }
bindings: [{ agent, match: { channel, peer } }]
```

## Gateway auth modes
- `token` — bearer token (used in Railway deploy via `OPENCLAW_GATEWAY_TOKEN`)
- `password` — password auth
- `trusted-proxy` — delegate to reverse proxy via header (used with `trustedProxies`)
- `none` — no auth (loopback only)

## Gateway bind modes
`loopback` (default) | `lan` | `tailnet` | `auto` | `custom`
Non-loopback requires auth. Railway deploy uses `bind: lan` behind Railway's proxy.

## `openclaw config set` — key paths
- `gateway.auth.token` — gateway token
- `gateway.bind` — bind mode
- `gateway.controlUi.allowedOrigins` — CORS origins array
- `gateway.trustedProxies` — proxy IP list
- `agents.defaults.model` — default model for all agents
- `channels.telegram.botToken` — Telegram bot token
- `channels.discord.token` — Discord bot token
- `channels.slack.botToken` / `channels.slack.appToken` — Slack tokens

## `openclaw onboard --non-interactive` flags used in this repo
```
--flow quickstart
--auth-choice <provider>       # e.g. anthropic-api-key
--secret-input-mode ref
--gateway-bind lan
--gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
--accept-risk
--skip-health
```

## Agent config files (live in agent workspace dir)
- `AGENTS.md` — operating manual: behavior, memory protocol, tool policy, group chat rules
- `SOUL.md` — character, values, boundaries; persists across session resets
- `IDENTITY.md` — name, creature type, vibe, emoji, avatar
- `USER.md` — profile of the human the agent assists; updated over time
- `TOOLS.md` — environment-specific tool config (SSH hosts, device names, etc.)
- `BOOTSTRAP.md` — one-time init script; **deleted after first run**
- `HEARTBEAT.md` — periodic checklist; empty = heartbeat API calls skipped
- `MEMORY.md` — curated long-term memory; private sessions only; priority over `memory.md`

Bootstrap files injected into system prompt each turn (cap: 20K chars/file, 150K total).

## Memory system
- Daily logs: `memory/YYYY-MM-DD.md` — append-only, auto-loaded for today + yesterday
- `MEMORY.md` — curated long-term store
- Tools: `memory_search` (semantic), `memory_get` (specific files)
- Memory flush: silent agent turn before context compaction

## Heartbeat
Periodic agent turn in main session (default every 30m). Reads HEARTBEAT.md. Responds `HEARTBEAT_OK` if nothing to do (suppressed). Uses `isolatedSession: true` + `lightContext: true` (~2-5K tokens).

## Session scopes
`main` | `per-peer` | `per-channel-peer` (recommended multi-user) | `per-account-channel-peer`
Session store: `~/.openclaw/agents/<agentId>/sessions/`

## Multi-agent routing (bindings)
Priority: specific peer → parent peer → Discord role+guild → guild → team → account → channel → default agent.
Each agent needs its own `agentDir` — **never share across agents**.

## Gateway HTTP APIs (all on same port, Bearer auth)
- `POST /v1/chat/completions` — OpenAI-compatible; agent via `model: "openclaw:<agentId>"`
- `POST /v1/responses` — OpenResponses API (must enable `gateway.http.endpoints.responses.enabled`)
- `POST /tools/invoke` — direct tool invocation

## Key CLI commands
```
openclaw onboard [--non-interactive]   # setup wizard
openclaw config get/set/unset <path>   # config management
openclaw config validate               # validate openclaw.json
openclaw gateway [run|status|health|install|start|stop|restart]
openclaw agents list|add|delete|bind|unbind
openclaw channels                      # manage chat accounts
openclaw doctor                        # health checks + quick fixes
openclaw logs                          # tail gateway logs
```

## SecretRef (non-plaintext credential storage)
```json5
{ "source": "env", "id": "MY_API_KEY" }  // also: "file", "exec"
```
Used with `--secret-input-mode ref` in non-interactive onboard.

## API key rotation
Priority: `OPENCLAW_LIVE_<P>_KEY` > `<P>_API_KEYS` (comma list) > `<P>_API_KEY` > `<P>_API_KEY_*`
Rotation triggers on 429 only.

---

# Openclaw Codebase Internals

Source: https://github.com/openclaw/openclaw — TypeScript monorepo (pnpm).

## Key source paths
```
src/entry.ts                          — CLI entry, process respawn, profile routing
src/cli/run-main.ts                   — CLI bootstrap, sub-command dispatch
src/commands/onboard.ts               — onboard wizard entry
src/commands/onboard-non-interactive/ — non-interactive setup (local.ts, remote.ts)
src/config/                           — config I/O, Zod schema, paths, defaults
src/gateway/server.impl.ts            — gateway startup
src/gateway/server/ws-connection.ts   — WebSocket handshake + auth
src/gateway/protocol/schema/          — frames, error codes, RPC method types
src/gateway/config-reload.ts          — hot-reload / restart logic
src/agents/pi-embedded-runner/run.ts  — agent turn execution loop
src/agents/system-prompt.ts           — system prompt assembly
src/channels/                         — channel plugin architecture
extensions/<channel>/                 — telegram, discord, slack, signal, etc.
```

## Config file resolution order
1. `OPENCLAW_CONFIG_PATH` env override
2. Search state dir: `openclaw.json` → `clawdbot.json` → `moldbot.json` → `moltbot.json`
3. State dir: `OPENCLAW_STATE_DIR` → `CLAWDBOT_STATE_DIR` → `~/.openclaw`

## Config parsing pipeline
JSON5 parse → `$include` resolve → `${ENV}` substitute → legacy migration → Zod validate → semantic checks (duplicate agents, avatar paths, gateway/tailscale compat, channel IDs, heartbeat targets, plugins)

## Config write — atomic
Writes to `${configPath}.${pid}.${uuid}.tmp` then renames. Permissions `0o600`. Audit log at `$STATE_DIR/logs/config-audit.jsonl`. Requires base hash on `config.set`/`config.apply` (concurrent write guard).

## Error messages — config
| Message | Cause |
|---|---|
| `"JSON5 parse failed: {error}"` | Malformed openclaw.json |
| `"Invalid config at [path]: - [path]: [message]"` (code `INVALID_CONFIG`) | Zod schema violation |
| `"read failed: ... fix ownership with: chown $(id -u) '...'"` | File permission denied |
| `MissingEnvVarError` | `${VAR}` reference in config but var not set |
| `"invalid config: [error]"` | Generic validation failure |
| `"identity.avatar must be a workspace-relative path, http(s) URL, or data URI."` | Bad avatar value |
| `"gateway.bind must resolve to loopback when gateway.tailscale.mode=[serve/funnel]"` | Bind/tailscale conflict |
| `"unknown channel id: [id]"` | Binding refs non-existent channel |

## Error messages — gateway / WS
| Message | Cause |
|---|---|
| `"another gateway instance is already listening on ws://{host}:{port}"` (`GatewayLockError`) | Port already occupied |
| `"failed to bind gateway socket on ws://{host}:{port}: {error}"` | Port bind failure |
| `"connect is only valid as the first request"` (INVALID_REQUEST) | WS protocol violation |
| `"gateway startup failed: {errMsg}. Process will stay alive; fix the issue and restart."` | Gateway init error — process stays alive |

## Auth failure reasons (WS connect)
`token_missing` | `token_mismatch` | `token_missing_config` | `password_missing` | `password_mismatch` | `password_missing_config` | `trusted_proxy_untrusted_source` | `trusted_proxy_user_missing` | `trusted_proxy_user_not_allowed` | `rate_limited` (includes `retryAfterMs`)

## RPC error codes
`NOT_LINKED` | `NOT_PAIRED` | `AGENT_TIMEOUT` | `INVALID_REQUEST` | `UNAVAILABLE`

## Error messages — session / agent
| Message | Cause |
|---|---|
| `INVALID_REQUEST: "session not found"` | Unknown session key on send/steer |
| `UNAVAILABLE: "the session is still active"` | Can't interrupt active session |
| `"webchat clients cannot patch sessions"` | WebChat trying to patch |
| `"context overflow"` | Context exceeded after all recovery attempts |

## Error messages — daemon install
| Message | Cause |
|---|---|
| `"Gateway install blocked: [reason] Fix gateway auth config/token input and rerun setup."` | Token/auth missing at install time |
| `"Gateway service install failed: [error]"` | OS-level daemon install failure |
| `"Non-interactive setup requires explicit risk acknowledgement"` | Missing `--accept-risk` flag |

## Agent runner — retry loop
Max 32–160 iterations. Retry triggers:
- **Auth failure** → runtime token refresh → rotate to next auth profile
- **Overload** → backoff + rotate profile
- **Rate limit / billing** → rotate profile
- **Context overflow** → compaction (up to 3 cycles) → tool result truncation → fail
- **Timeout** → rotate profile (no penalty)
- **Thinking level rejection** → pick supported level, retry same profile

## Gateway startup sequence
1. Load + validate config snapshot; apply migrations
2. Activate secrets
3. Load plugin registry (gateway + channel plugins)
4. Create HTTP/WS servers
5. Start `channelManager` (channel plugin lifecycle)
6. Register event subscriptions
7. Start background services (maintenance, health monitor, discovery, cron)
8. Start sidecar services (browser, plugins)
9. Attach WS handlers

## Config hot-reload (file watcher, 300ms debounce)
- `off` — no reload
- `restart` — always restart
- `hot` — hot-reload safe changes only; warns when restart needed
- `hybrid` (default) — hot if possible, else restart
- Restart: `SIGUSR1` → in-process restart, 90s drain; `SIGTERM`/`SIGINT` → graceful shutdown, 5s timeout

## Gateway IPC / CLI comms
- CLI calls gateway via WebSocket RPC: `callGatewayFromCli()` → `ws://127.0.0.1:18789`
- Auth: bearer token in `ConnectParams`, challenge-response handshake
- Default RPC timeout: 30s
- TCP probe to check if gateway running before CLI commands

## Channel plugin structure
Each channel is a bundled npm package in `extensions/<channel>/`. Activated via `channelManager.startChannel()`. All 13 bundled channels: `telegram`, `discord`, `slack`, `signal`, `irc`, `mattermost`, `nextcloudTalk`, `bluebubbles`, `imessage`, `feishu`, `line`, `synologyChat`, `zalo`.

## Non-interactive onboard — what it writes
`agents.defaults.workspace`, `agents.defaults.model`, `gateway.port/bind/auth.*`, channel token paths, `skills.install.nodeManager`, `wizard.lastRunAt/Version/Command/Mode`

## `--accept-risk` flag
Required for `--non-interactive`. Without it: `"Non-interactive setup requires explicit risk acknowledgement"`. This is what `--accept-risk` maps to in this template's `runAutoSetup()`.

## `openclaw gateway call` — low-level RPC from CLI
```
openclaw gateway call <method> --json --params '<json>' --token <token> --timeout <ms>
```
- `--params` takes a JSON object string (default `"{}"`)
- `--json` outputs machine-readable JSON
- `--token` / `--password` for gateway auth (picks up from config automatically if set)
- Used in this template to call `sessions.list` and `sessions.reset` programmatically

## Session RPC — verified shapes

### `sessions.list` response
```json
{
  "ts": <epoch>,
  "count": <n>,
  "sessions": [
    {
      "key": "agent:<agentId>:<scope>",   // e.g. "agent:people-lead:main"
      "kind": "direct",
      "sessionId": "<uuid>",
      "updatedAt": <epoch>,
      "inputTokens": <n>,
      "outputTokens": <n>,
      ...
    }
  ]
}
```
Filter sessions by agent: `s.key.startsWith("agent:<agentId>:")`

### `sessions.reset` params + response
```
params: { "key": "agent:<agentId>:<scope>", "reason": "reset" }

response: { "ok": true, "key": "...", "entry": { "sessionId": "<new-uuid>", "inputTokens": 0, ... } }
```
- Mirrors TUI `/reset` — archives transcripts, aborts active runs, clears queues, generates new sessionId
- Does NOT delete files — transcripts are archived, not destroyed

## Session reset — when to use
Only reset when identity-critical config changes: session keys, auth tokens, SOUL.md/IDENTITY.md rewrites. Routine AGENTS.md/TOOLS.md instruction updates don't need a reset — bootstrap files are re-read from disk on every turn. Session history takes precedence over system prompt when there's a conflict, which is why reset is needed for value changes the agent already "knows".
