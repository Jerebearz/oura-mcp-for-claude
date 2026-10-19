# AGENTS.md: guide for AI coding agents

This repo is a **single-user, read-only Oura Ring MCP server** on Cloudflare Workers. People usually arrive here asking an agent to "set this up for me", "why isn't my Oura connector working" or "add a tool". Follow this file. A shorter summary is in `llms.txt`.

**Fastest way to see where a user stands:** `npm run doctor -- --json`, run in the project folder. It's non-interactive and never prints secrets. Or `curl https://<worker>/status`. Both return a `next_step`.

## Helping someone set it up

Goal: their own deployment at `https://personal-oura-mcp.<their-subdomain>.workers.dev/mcp`, added to Claude as a custom connector.

1. Check prerequisites: `node --version` (≥ 20, ideally 22), `git --version`. They also need an **active Oura membership** (API access requires it) and a free Cloudflare account.
2. Run:
   ```sh
   git clone https://github.com/Jerebearz/oura-mcp-for-claude.git
   cd oura-mcp-for-claude
   npm install
   npm run setup
   ```
   `npm run setup` (`scripts/setup.mjs`) is **interactive and re-runnable**. Run it in a real terminal the user can type into. If your tool can't hand the terminal to the user, have them run it themselves and relay what it prints. It:
   - runs `wrangler login` (browser),
   - runs `wrangler deploy --x-auto-create` (auto-creates the `OAUTH_KV` namespace),
   - prints the exact Oura developer-app form values (website, privacy, terms, redirect URI and scopes, all derived from the deployed URL),
   - asks for the Oura Client ID and Secret, **verifies them against Oura's token endpoint**, and stores them with `wrangler secret put`,
   - asks for `TIMEZONE` (IANA name),
   - opens `<url>/setup` so the user can sign in and read their **Oura user ID**, then stores `ALLOWED_OURA_USER_ID`,
   - confirms readiness via `<url>/status`, and saves the URL to `.oura-mcp.json` (gitignored) for `npm run doctor`.
3. Verify with `npm run doctor -- --json`. Expect `"ok": true`.
4. Tell them to add the connector: **claude.ai → Settings → Connectors → Add custom connector**, URL `<url>/mcp`, OAuth fields empty, then **Connect**.

**No terminal?** Point them to the **Deploy to Cloudflare** button in the README. They enter `pending` for the Oura fields if they have no app yet. Then the deployed Worker's home page (`https://<worker>/`) is a live checklist with the exact Oura form values, and it explains where to add each secret in the Cloudflare dashboard.

**Rules while helping:**
- **Never ask the user to paste the Oura Client Secret, the cookie key or any token into the chat**, and never echo them. They type secrets into the setup script or `wrangler secret put`, which reads stdin. If a secret does land in the chat or a screenshot, tell them to regenerate it in the Oura portal.
- The Oura user ID and the workers.dev URL are not secrets.
- You can't do browser steps (Cloudflare login, Oura form, Oura sign-in). Give exact, copyable values.
- Prefer re-running `npm run setup` (or `npm run setup -- --reconfigure`) over hand-editing config. `wrangler.jsonc` has nothing user-specific.

**Windows users** (PowerShell) often hit these:
- `open -e file` doesn't exist: use `notepad file`. `cp` works, but `copy` is the native command.
- Clicking inside a PowerShell window **pauses** the running process (QuickEdit "Select" mode). If a local server "hangs", press Esc in its window.
- In a `wrangler dev` window, single keys are shortcuts (`t` opens a public tunnel, `x` exits). Tell users not to type there.
- Use `localhost`, not `127.0.0.1`, in local URLs. Oura redirect URIs must match exactly.
- Notepad may save `.dev.vars` as `.dev.vars.txt`. Check with `dir .dev*`.

**Diagnosing:** start with `npm run doctor -- --json` or `GET <worker>/status`. For login failures, the Worker logs only status lines (`npx wrangler tail` for production, or the `npm run dev` window locally).
- `oura token endpoint: HTTP 401 invalid_client` means the Client ID/Secret pair is wrong. Usually the secret was regenerated after copying. Re-run `npm run setup -- --reconfigure`.
- The "Access denied" page shows the signed-in ID and a hint about the configured one.
- 401/403 on a single tool means that Oura scope isn't enabled on their Oura app.
- MCP Inspector "Invalid redirect URI" means a stale client registration. Use a fresh private browser window.

## Architecture

```
src/index.ts          OAuthProvider + stateless MCP handler (agents/mcp/server createMcpHandler, MCP SDK v2);
                      tokenExchangeCallback refreshes Oura tokens; allowlist re-checked per request
src/auth-handler.ts   /authorize (consent page), /callback (Oura code exchange + allowlist),
                      /setup (owner ID discovery, only while ALLOWED_OURA_USER_ID is unset),
                      / (setup checklist until configured), /status (JSON, booleans only), /privacy, /terms
src/tools.ts          Tool definitions (zod v4 schemas, readOnlyHint annotations), date handling, error mapping
src/oura/client.ts    Read-only Oura API client (pagination, readable errors, never logs bodies)
src/oura/tokens.ts    Oura token exchange/refresh (client_secret_post, HTTP Basic fallback)
src/oura/transform.ts Compact per-endpoint field pickers, heart-rate aggregation
src/dates.ts          Timezone-aware (IANA, DST-safe) date ranges, default 7 days, max 90
src/allowlist.ts      Owner check (normalises copy/paste artifacts)
src/base-url.ts       Public origin = request origin, or PUBLIC_BASE_URL if set
src/settings.ts       Config status (booleans), "pending" placeholder, auto-generated cookie key in KV
src/consent-page.ts   HTML: consent page, home/checklist page, ID page, privacy/terms
src/env.d.ts          Optional env keys not prompted by the Deploy button
scripts/setup.mjs     Interactive deploy + configuration
scripts/doctor.mjs    Non-interactive health check (--json for agents)
.dev.vars.example     Keys the Deploy button prompts for (keep it to OURA_CLIENT_ID, OURA_CLIENT_SECRET, TIMEZONE)
package.json          `cloudflare.bindings` = field descriptions shown on the Deploy button page
```

Key libraries, and their **current** APIs (check `node_modules/*/README.md` and `docs/`, not memory):
- `@cloudflare/workers-oauth-provider` 1.x: `beginConsent` / `approveConsent` / `beginUpstream` / `finishUpstream` / `completeAuthorization`, and `tokenExchangeCallback` returning `{ newProps, accessTokenTTL }`.
- `agents` (`agents/mcp/server`): `createMcpHandler(factory)` and `getMcpAuthContext().props`. `McpAgent` is deprecated.
- `@modelcontextprotocol/server` v2: `server.registerTool(name, { inputSchema: z.object(...) }, cb)`.
- Oura API v2: `https://api.ouraring.com/v2/usercollection/*`, OAuth at `cloud.ouraring.com/oauth/authorize` and `api.ouraring.com/oauth/token`. VO2 max lives at `vO2_max`. Scope map: `daily` covers readiness/sleep/activity/stress, `stress` covers resilience, `heart_health` covers VO2 max and cardiovascular age, and `spo2`, `heartrate`, `workout` and `personal` cover their own data. Oura drops unknown or unticked scopes silently, so failures show up later as 401s.

## Invariants (don't break these)

- **Read-only.** Only GET requests to Oura. No tools that write.
- **Never log health data, tokens or secrets.** Log status codes and error names only.
- **Single user.** `isAllowedOuraUser` is checked at `/callback`, in `tokenExchangeCallback` and in the `/mcp` handler. Keep all three.
- **No new unauthenticated endpoints** beyond the OAuth flow, `/setup` (self-disabling), `/`, `/status` and the static pages. `/` and `/status` must only expose booleans, never setting values.
- In Workers, call `fetch` unbound. `this.fetcher(...)` with the global `fetch` throws "Illegal invocation" (there's a regression test).
- Keep tool responses compact. Don't return Oura's raw payloads.

## Adding a tool

1. Find the Oura v2 endpoint and its scope. If the scope is new, add it to `OURA_SCOPES` in `src/config.ts`, and tell users to tick it in their Oura app and reconnect.
2. Add a compact transformer in `src/oura/transform.ts`.
3. Add an entry to `DAILY_TOOLS` in `src/tools.ts` (date-keyed collections), or a custom `registerTool` call. Write a description that tells Claude *when* to use it.
4. Add tests in `test/`, then run `npm test && npm run type-check`.
5. Deploy with `npm run deploy`.

## Commands

```sh
npm test            # vitest
npm run type-check  # tsc --noEmit
npm run dev         # local server on http://localhost:8788 (needs .dev.vars)
npm run deploy      # wrangler deploy
npm run doctor      # health check (add -- --json for machine-readable output)
npm run cf-typegen  # regenerate worker-configuration.d.ts (from .dev.vars.example) after changing bindings
```

CI (`.github/workflows/ci.yml`) runs the type-check, the tests and a `wrangler deploy --dry-run` bundle check on every push and PR. Keep them green.
