# Security

This server handles personal health data, so security reports are very welcome.

**Please report vulnerabilities privately** via GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

## Design summary

- Single user: the Oura account in `ALLOWED_OURA_USER_ID` is checked at login, on every token refresh, and on every MCP request.
- Read-only: only `GET` requests to the Oura API.
- Oura tokens are stored only inside encrypted OAuth grant props ([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)); MCP tokens are stored hashed.
- Health data and tokens are never logged or stored.
- Consent page: anti-framing headers, CSP, browser-bound one-time handles; `state` bound to the browser.
- Unauthenticated routes: OAuth endpoints, `/setup` (disabled once an owner is set), `/`, `/status` (booleans only), `/privacy`, `/terms`.

## If you leaked a secret

Regenerate the Client Secret in the [Oura developer portal](https://developer.ouraring.com/applications), then run `npm run setup -- --reconfigure` (or `npx wrangler secret put OURA_CLIENT_SECRET`).
