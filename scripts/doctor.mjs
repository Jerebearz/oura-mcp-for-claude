#!/usr/bin/env node
/**
 * Non-interactive health check, safe for humans and AI agents to run.
 *
 *   npm run doctor                         uses the URL saved by `npm run setup`
 *   npm run doctor -- https://personal-oura-mcp.<you>.workers.dev
 *   npm run doctor -- --json               machine-readable output
 *
 * Never prints secret values: it only checks which secrets exist and what the
 * deployed server reports about itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const urlArg = args.find((a) => /^https?:\/\//.test(a));
const isWin = process.platform === "win32";

const checks = [];
const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(ok ? {} : { fix }) });

function wrangler(cmdArgs) {
	return spawnSync("npx", ["wrangler", ...cmdArgs], { shell: isWin, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fetchJson(url, init) {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
	let body;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	return { res, body };
}

async function main() {
	const [major] = process.versions.node.split(".").map(Number);
	add("node", major >= 20, `Node ${process.versions.node}`, "Install Node 22 LTS from https://nodejs.org");
	add("dependencies", existsSync("node_modules"), existsSync("node_modules") ? "installed" : "missing", "Run: npm install");

	const who = wrangler(["whoami"]);
	const loggedIn = who.status === 0 && !/not authenticated/i.test(`${who.stdout}${who.stderr}`);
	add("cloudflare_login", loggedIn, loggedIn ? "logged in" : "not logged in", "Run: npx wrangler login");

	if (loggedIn) {
		const list = wrangler(["secret", "list", "--format", "json"]);
		let names = [];
		try {
			names = JSON.parse(list.stdout).map((s) => s.name);
		} catch {
			// worker may not exist yet
		}
		const has = (n) => names.includes(n);
		add(
			"secrets_oura_app",
			has("OURA_CLIENT_ID") && has("OURA_CLIENT_SECRET"),
			`OURA_CLIENT_ID ${has("OURA_CLIENT_ID") ? "set" : "missing"}, OURA_CLIENT_SECRET ${has("OURA_CLIENT_SECRET") ? "set" : "missing"}`,
			"Run: npm run setup (or npx wrangler secret put OURA_CLIENT_ID / OURA_CLIENT_SECRET)",
		);
		add(
			"secret_owner",
			has("ALLOWED_OURA_USER_ID"),
			has("ALLOWED_OURA_USER_ID") ? "set" : "missing",
			"Open <url>/setup to see your Oura user ID, then: npx wrangler secret put ALLOWED_OURA_USER_ID",
		);
		add("secret_timezone", has("TIMEZONE"), has("TIMEZONE") ? "set" : "not set (UTC is used)", "Run: npx wrangler secret put TIMEZONE  (e.g. Europe/London)");
	}

	let url = urlArg;
	if (!url && existsSync(".oura-mcp.json")) {
		try {
			url = JSON.parse(readFileSync(".oura-mcp.json", "utf8")).url;
		} catch {
			// ignore
		}
	}
	url = url?.replace(/\/+$/, "");
	add("server_url", Boolean(url), url ?? "unknown", "Pass it: npm run doctor -- https://personal-oura-mcp.<you>.workers.dev (or run npm run setup)");

	let nextStep;
	if (url) {
		try {
			const { res, body } = await fetchJson(`${url}/status`);
			const ok = res.ok && body?.name === "oura-mcp-for-claude";
			add("server_reachable", ok, ok ? `v${body.version}` : `HTTP ${res.status}`, "Deploy with: npm run deploy");
			if (ok) {
				add("server_ready", body.ready, body.ready ? "fully configured" : body.next_step, body.next_step);
				nextStep = body.next_step;
			}
		} catch (e) {
			add("server_reachable", false, `could not reach ${url}: ${e?.name ?? e}`, "Check the URL, then deploy with: npm run deploy");
		}
		try {
			const { res, body } = await fetchJson(`${url}/.well-known/oauth-protected-resource/mcp`);
			const ok = res.ok && body?.resource === `${url}/mcp`;
			add("oauth_metadata", ok, ok ? "resource matches URL" : `resource=${body?.resource ?? "?"} (HTTP ${res.status})`, "If you use a custom domain, set PUBLIC_BASE_URL");
		} catch {
			add("oauth_metadata", false, "unreachable", "Deploy with: npm run deploy");
		}
		try {
			const res = await fetch(`${url}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				signal: AbortSignal.timeout(10_000),
			});
			const ok = res.status === 401 && /resource_metadata/.test(res.headers.get("www-authenticate") ?? "");
			add("mcp_requires_auth", ok, `unauthenticated /mcp → HTTP ${res.status}`, "Unexpected: /mcp should return 401. Redeploy with: npm run deploy");
		} catch {
			add("mcp_requires_auth", false, "unreachable", "Deploy with: npm run deploy");
		}
	}

	const ok = checks.every((c) => c.ok);
	const firstFail = checks.find((c) => !c.ok);
	const result = {
		ok,
		url: url ?? null,
		mcp_url: url ? `${url}/mcp` : null,
		next_step: ok ? `Ready. In Claude: Settings → Connectors → Add custom connector → ${url}/mcp` : (firstFail?.fix ?? nextStep),
		checks,
	};

	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log("\nOura MCP doctor\n");
		for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name.padEnd(20)} ${c.detail}`);
		console.log(`\nNext: ${result.next_step}\n`);
	}
	process.exit(ok ? 0 : 1);
}

main();
