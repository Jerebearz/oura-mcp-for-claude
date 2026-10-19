import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

/** Escape anything that may have come from the (self-registered, untrusted) MCP client. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const PAGE_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
].join("; ");

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; padding: 24px 16px; }
  main { max-width: 440px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  p { line-height: 1.5; }
  .warn { background: #fef3c7; padding: 10px 12px; border-radius: 8px; }
  .muted { color: #57534e; font-size: .9rem; }
  .id { display: block; font: 600 1.05rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f5f5f4; border: 1px solid #d6d3d1; border-radius: 8px; padding: 12px; word-break: break-all; user-select: all; -webkit-user-select: all; cursor: text; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
  h2 { font-size: 1rem; margin: 20px 0 6px; }
  ul.check { list-style: none; padding: 0; margin: 8px 0; }
  ul.check li { padding: 6px 0; line-height: 1.4; }
  table.form { width: 100%; border-collapse: collapse; font-size: .9rem; }
  table.form td { padding: 5px 4px; vertical-align: top; border-bottom: 1px solid #e7e5e4; }
  table.form td:first-child { white-space: nowrap; color: #57534e; padding-right: 10px; }
  table.form code { word-break: break-all; user-select: all; -webkit-user-select: all; }
  ol { padding-left: 20px; line-height: 1.5; }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 12px; border-radius: 8px; border: 1px solid #d6d3d1; font-size: 1rem; cursor: pointer; background: #fff; }
  button.primary { background: #1c1917; color: #fff; border-color: #1c1917; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f5f5f4; }
    main { background: #292524; }
    .muted { color: #a8a29e; }
    .warn { background: #78350f; }
    .id { background: #1c1917; border-color: #57534e; }
    button { background: #292524; color: #f5f5f4; border-color: #57534e; }
    button.primary { background: #f5f5f4; color: #1c1917; }
  }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderConsentPage(details: ConsentDescription, handle: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	return layout(
		`Connect ${details.clientName} to Oura`,
		`<h1>Allow ${name} to read your Oura data?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${
	details.redirectIsLoopback
		? '<p class="warn"><strong>This sends access to an app on this computer.</strong> Continue only if you just started connecting from it.</p>'
		: ""
}
<p class="muted">Read-only: readiness, sleep, activity, heart rate, workouts, stress, resilience, SpO2, VO2 max and cardiovascular age. You will sign in with Oura next. Only the allowed Oura account can connect.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="actions">
    <button name="decision" value="deny">Deny</button>
    <button class="primary" name="decision" value="approve">Continue to Oura</button>
  </div>
</form>`,
	);
}

export function renderErrorPage(title: string, message: string): string {
	return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function htmlHeaders(base?: Headers): Headers {
	const headers = new Headers(base);
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Content-Security-Policy", PAGE_CSP);
	headers.set("X-Frame-Options", "DENY");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", "no-store");
	headers.set("Referrer-Policy", "no-referrer");
	return headers;
}

/** Shows the signed-in Oura account its own user ID in a one-click-selectable box. */
export function renderOuraIdPage(title: string, ouraUserId: string, intro: string, next: string): string {
	return layout(
		title,
		`<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(intro)}</p>
<p class="muted">Your Oura user ID (click once to select it, then copy):</p>
<code class="id">${escapeHtml(ouraUserId)}</code>
<p>${escapeHtml(next)}</p>`,
	);
}

const PRIVACY_HTML = `<h1>Privacy</h1>
<p>This is a personal, single-user server. It lets its owner's Claude read the owner's own Oura Ring data. It is not a public service.</p>
<h2>Who can use it</h2><p>Only the one Oura account configured by the owner. Every other account is rejected at sign-in and nothing is stored for it.</p>
<h2>What it reads</h2><p>Read-only Oura data (readiness, sleep, activity, heart rate, workouts, stress, resilience, SpO2, VO2 max, cardiovascular age) and the Oura user ID used for the access check.</p>
<h2>What it stores</h2><p>No health data. Only the encrypted OAuth tokens needed to keep the connection working, in the owner's Cloudflare account.</p>
<h2>Logging</h2><p>Health data and tokens are never logged.</p>
<h2>Revoking access</h2><p>Revoke the app in your Oura account, remove the connector in Claude, or delete the Worker.</p>`;

const TERMS_HTML = `<h1>Terms</h1>
<p>This is a personal tool used only by its owner with their own Oura account. No one else may use it.</p>
<p>It is provided as-is, without warranty, for personal informational use. It is not a medical device and does not give medical advice.</p>
<p>Use of Oura data is also subject to Oura's own terms and API agreement.</p>`;

export function renderStaticPage(page: "privacy" | "terms"): string {
	return layout(page === "privacy" ? "Privacy" : "Terms", page === "privacy" ? PRIVACY_HTML : TERMS_HTML);
}

export interface HomePageInfo {
	baseUrl: string;
	version: string;
	repoUrl: string;
	ouraApp: boolean;
	owner: boolean;
	timezoneSet: boolean;
	timezone: string;
}

const tick = (ok: boolean) => (ok ? "✅" : "⬜");

/**
 * Home page. Fully configured: a short description plus the connector URL.
 * Otherwise: a setup checklist with the exact Oura form values for this
 * deployment. Shows only whether settings exist, never their values.
 */
export function renderHomePage(i: HomePageInfo): string {
	const b = escapeHtml(i.baseUrl);
	const links = `<p class="muted"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="${escapeHtml(i.repoUrl)}">Source</a> · v${escapeHtml(i.version)}</p>`;
	if (i.ouraApp && i.owner) {
		return layout(
			"Personal Oura MCP",
			`<h1>Personal Oura MCP server</h1>
<p>A private, read-only <a href="https://modelcontextprotocol.io">MCP</a> server that lets its owner's Claude read their own Oura Ring data. Only the owner's Oura account can connect.</p>
<p class="muted">Claude connector URL:</p>
<code class="id">${b}/mcp</code>
${links}`,
		);
	}
	const secretHelp = `In the <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages">Cloudflare dashboard</a>: <b>Workers &amp; Pages → this Worker → Settings → Variables and Secrets → Add</b> (type <i>Secret</i>). Or run <code>npx wrangler secret put NAME</code> in the project folder.`;
	return layout(
		"Finish setting up",
		`<h1>Almost there: finish setup</h1>
<p>This Oura connector is deployed. Complete these steps; this page updates as you go (refresh it).</p>
<ul class="check">
<li>${tick(i.ouraApp)} <b>1. Oura app credentials</b>: secrets <code>OURA_CLIENT_ID</code> and <code>OURA_CLIENT_SECRET</code></li>
<li>${tick(i.owner)} <b>2. Lock to your Oura account</b>: secret <code>ALLOWED_OURA_USER_ID</code></li>
<li>${tick(i.timezoneSet)} <b>Timezone</b> (optional): secret <code>TIMEZONE</code>, now <code>${escapeHtml(i.timezone)}</code></li>
</ul>
<h2>1. Create your Oura app</h2>
<p>At <a href="https://developer.ouraring.com/applications">developer.ouraring.com/applications</a>, create an application with:</p>
<table class="form">
<tr><td>Website</td><td><code>${b}</code></td></tr>
<tr><td>Privacy Policy</td><td><code>${b}/privacy</code></td></tr>
<tr><td>Terms of Service</td><td><code>${b}/terms</code></td></tr>
<tr><td>Redirect URI</td><td><code>${b}/callback</code></td></tr>
<tr><td>Scopes</td><td>Personal, Daily, Heartrate, Workout, SpO2, Stress, Heart Health</td></tr>
</table>
<p>Then save its Client ID and Client Secret as the secrets <code>OURA_CLIENT_ID</code> and <code>OURA_CLIENT_SECRET</code>. ${secretHelp}</p>
<h2>2. Lock it to your Oura account</h2>
<p>${i.ouraApp ? `Open <a href="/setup"><b>${b}/setup</b></a>, sign in to Oura, and copy the user ID it shows. Save it as the secret <code>ALLOWED_OURA_USER_ID</code>.` : "Available after step 1."}</p>
<h2>3. Add it to Claude</h2>
<p>claude.ai → Settings → Connectors → <b>Add custom connector</b>, URL:</p>
<code class="id">${b}/mcp</code>
<p class="muted">Leave the OAuth fields empty, then click Connect. Works in the Claude mobile apps too.</p>
${links}`,
	);
}
