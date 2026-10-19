# Personal Oura MCP

**Your own private Oura Ring connector for Claude.** It works on claude.ai, Claude Desktop and the **Claude mobile apps**, runs free on Cloudflare Workers, and can only ever be used by **your** Oura account.

Ask Claude things like:

- *"How have my readiness and HRV trended over the last month?"*
- *"Did late workouts hurt my deep sleep this week?"*
- *"Compare my resting heart rate on days I hit 10k steps vs. days I didn't."*

It's a [remote MCP server](https://modelcontextprotocol.io) that signs you in with Oura (OAuth), checks that the Oura account is yours, and then gives Claude **read-only** access to your data through 11 tools.

> Not affiliated with Oura or Anthropic. Uses the official [Oura API v2](https://cloud.ouraring.com/v2/docs). Oura retired personal access tokens in December 2025, so OAuth (what this uses) is now the only way in.

---

## Quick start (about 15 minutes)

**You need:**
- An Oura account with an active membership. API access requires one.
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
- [Node.js 22 LTS](https://nodejs.org) and [Git](https://git-scm.com/downloads).
- A Claude plan that supports custom connectors.

```sh
git clone https://github.com/Jerebearz/oura-mcp-for-claude.git
cd oura-mcp-for-claude
npm install
npm run setup
```

`npm run setup` walks you through everything and checks each step:

1. **Logs in to Cloudflare** in your browser.
2. **Deploys the server** and creates its storage. You get a URL like `https://personal-oura-mcp.<you>.workers.dev`.
3. **Prints exactly what to type into Oura's developer-app form**, including the redirect URI, privacy and terms links, and which scopes to tick. You paste back the Client ID and Secret, and it **verifies them with Oura** before saving.
4. **Asks for your timezone**, detected automatically, so "today" and "last 7 days" mean your days.
5. **Locks the server to your Oura account.** It opens `/setup`, where you sign in to Oura and see your user ID. You paste the ID back.

Then add it to Claude:

1. Go to **claude.ai → Settings → Connectors → Add custom connector**.
2. Fill in:
   - **Name:** `Oura`
   - **URL:** `https://personal-oura-mcp.<you>.workers.dev/mcp`
   - Leave the OAuth fields empty.
3. Click **Connect**, then **Continue to Oura**, then sign in and approve.
4. Enable the connector in a chat. It syncs to the Claude mobile apps automatically.

Your computer doesn't need to stay on. The server runs on Cloudflare, and normal personal use fits easily in Cloudflare's free plan.

### Let Claude set it up for you

In [Claude Code](https://claude.com/claude-code), or any coding agent with a terminal, say:

> Set up https://github.com/Jerebearz/oura-mcp-for-claude for me. Follow its AGENTS.md.

The agent runs the commands and explains each step. You only do the browser parts: the Cloudflare login, the Oura form and the Oura sign-in.

---

## Tools

Every tool is read-only and takes optional `start_date` / `end_date` in `YYYY-MM-DD`. The defaults are the last 7 days and the maximum is 90 days. Dates are calendar days in your configured `TIMEZONE`. Responses are compact JSON, not Oura's full raw payloads.

| Tool | Oura data | Returns |
|---|---|---|
| `get_daily_readiness` | Readiness | score, temperature deviation, contributors |
| `get_daily_sleep` | Sleep score | score, contributors |
| `get_sleep_sessions` | Sleep periods | bed/wake times, total/deep/REM/light/awake minutes, efficiency, latency, average HRV, average and lowest HR, breathing rate |
| `get_daily_activity` | Activity | score, steps, calories, activity minutes, contributors |
| `get_heart_rate` | Heart rate | min/avg/max bpm per local **hour** (≤7 days) or **day**, by source |
| `get_workouts` | Workouts | activity, start/end, intensity, calories, distance |
| `get_daily_stress` | Stress | stress-high and recovery-high minutes, day summary |
| `get_daily_resilience` | Resilience | level, contributors |
| `get_daily_spo2` | SpO2 | average SpO2 %, breathing disturbance index |
| `get_vo2_max` | VO2 max | VO2 max |
| `get_cardiovascular_age` | Cardiovascular age | vascular age |

**Oura scopes requested:** `personal daily heartrate workout spo2 stress heart_health`. Nothing else, not even email.

---

## How it works and why it's safe

```
Claude ──/authorize──▶ consent page ──▶ Oura login ──▶ /callback
                                                     │ exchange code, read Oura user ID
                                                     │ ID == ALLOWED_OURA_USER_ID ?  else 403, nothing stored
                                                     ▼
                         MCP token issued (Oura tokens encrypted inside the grant)
Claude ──Bearer──▶ /mcp ──▶ tools ──▶ api.ouraring.com (GET only)
Claude ──refresh──▶ /token ──▶ Oura tokens refreshed automatically
```

- **Only your Oura account can connect.** It's checked at login, on every token refresh, and on every request.
- **Your Oura tokens are stored encrypted** inside the OAuth grant (via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)), in your own Cloudflare account. No health data is stored anywhere.
- **Health data and tokens are never logged.** Only status lines are, such as `oura /v2/usercollection/sleep: HTTP 429`.
- **Rate limiting** allows 30 tool calls per minute per connection.
- **The consent page** follows MCP's confused-deputy guidance: it can't be framed or forged, and the state is bound to your browser.
- **Public pages:**
  - the OAuth endpoints (`/authorize`, `/callback`, `/token`, `/register`, `/.well-known/*`),
  - static `/`, `/privacy` and `/terms` pages, which the Oura form asks for,
  - `/setup`, which only works until your Oura ID is set and then switches itself off.
- **All secrets live in Cloudflare secrets**, never in code: `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `ALLOWED_OURA_USER_ID` and `TIMEZONE`.

Built on Cloudflare's [`agents`](https://www.npmjs.com/package/agents) `createMcpHandler` (stateless Streamable HTTP) and MCP SDK v2.

---

## Day-to-day

| I want to… | Run |
|---|---|
| Update to the latest version | `git pull && npm install && npm run deploy` |
| Change the Oura client ID/secret or timezone | `npm run setup -- --reconfigure` |
| Rotate one secret | `npx wrangler secret put <NAME>`. It takes effect immediately, with no redeploy needed. |
| See logs (status lines only) | `npx wrangler tail` |

**Revoking access**, from lightest to most complete:
1. In Claude, go to **Settings → Connectors → Oura** and click **Disconnect**.
2. In Oura, revoke the app under authorized apps, or delete it in the [developer portal](https://developer.ouraring.com/applications).
3. To block every client instantly, run `npx wrangler secret put ALLOWED_OURA_USER_ID` and enter `disabled`.
4. To delete everything, run `npx wrangler delete`, then delete the `OAUTH_KV` namespace in the Cloudflare dashboard and the Oura app.

---

## Local development (optional)

```sh
cp .dev.vars.example .dev.vars     # fill in the values (Windows: copy .dev.vars.example .dev.vars)
npm run dev                        # http://localhost:8788
npx @modelcontextprotocol/inspector@latest
```

Add `http://localhost:8788/callback` as a redirect URI in your Oura app. In the Inspector, add a **Streamable HTTP** server with the URL `http://localhost:8788/mcp`.

```sh
npm test            # unit tests
npm run type-check
```

---

## Troubleshooting

These are real problems hit during setup, and their fixes.

| Symptom | Fix |
|---|---|
| **"Oura sign-in failed: could not exchange the authorization code"** / `401 invalid_client` in logs | The Client Secret doesn't match the Oura app. It was probably regenerated after you copied it. Copy it again, or regenerate it, then run `npm run setup -- --reconfigure`. The setup script checks the pair with Oura before saving. |
| **"Access denied"** after the Oura login | You signed in with a different Oura account than the allowlisted one. The page shows both IDs so you can compare. |
| **"Setup: allowlist not configured"** | `ALLOWED_OURA_USER_ID` isn't set. Copy the ID shown and run `npx wrangler secret put ALLOWED_OURA_USER_ID`, or finish `npm run setup`. |
| One tool returns **401/403** while others work | That scope wasn't ticked in your Oura app. SpO2, Stress and Heart Health are easy to miss. Tick it, then disconnect and reconnect in Claude. |
| **"Invalid redirect URI"** in the MCP Inspector | The Inspector reused an old registration. Close **all** private windows, then open the Inspector in a new private window and add the server again. |
| Local server **hangs** and pages never load (Windows) | Clicking inside a PowerShell window pauses the program in it ("Select" mode). Press **Esc** in that window, and from then on only click its title bar. |
| `npm run dev` prints **"Sharing via Cloudflare Tunnel"** | You pressed `t` in the server window. Single keys there are shortcuts. Press **Ctrl+C** and start it again. |
| Local login works at `localhost` but not `127.0.0.1` | Use `http://localhost:8788` everywhere. Oura's redirect URI must match exactly. |
| Inspector says **"PORT IS IN USE"** | An old Inspector is still running. Close its window, or on Windows run `Get-NetTCPConnection -LocalPort 6274 -State Listen \| % { Stop-Process -Id $_.OwningProcess -Force }`. |
| Windows: `open` is not recognized | Use `notepad <file>` instead of `open -e`. |

---

## FAQ

**Does my computer need to be on?** No. After setup it runs on Cloudflare around the clock.

**What does it cost?** Nothing for personal use on Cloudflare's free plan. Oura API access needs an active Oura membership.

**Can other people use my server?** No. Only the one Oura account in `ALLOWED_OURA_USER_ID` can connect. Everyone else gets a 403 and nothing is stored.

**Can I use a different timezone, or move?** Yes. Run `npm run setup -- --reconfigure`, or `npx wrangler secret put TIMEZONE`, with an IANA name like `Europe/London`. Daylight saving is handled.

**Can I add more tools?** Yes. See `src/tools.ts` and `AGENTS.md`.

## License

MIT. See [LICENSE](LICENSE).
