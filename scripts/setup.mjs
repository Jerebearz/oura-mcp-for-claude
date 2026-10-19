#!/usr/bin/env node
/**
 * Interactive, re-runnable setup for personal-oura-mcp.
 *
 *   npm run setup                 deploy + configure whatever is missing
 *   npm run setup -- --reconfigure  ask again for Oura app credentials and timezone
 *
 * It never prints or logs secret values. Secrets are sent to Cloudflare with
 * `wrangler secret put` over stdin.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const isWin = process.platform === "win32";
const reconfigure = process.argv.includes("--reconfigure");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, title) => console.log(`\n${bold(`── Step ${n}: ${title}`)}`);

// ---------------------------------------------------------------- helpers

/** Run `npx wrangler ...`. Interactive unless `input` or `capture` is given. */
function wrangler(args, { input, capture = false, env } = {}) {
	const piped = input !== undefined || capture;
	return spawnSync("npx", ["wrangler", ...args], {
		shell: isWin, // .cmd shims need a shell on Windows
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
		stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
	});
}

function ask(question, { defaultValue, hidden = false } = {}) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		if (hidden) {
			// Echo * instead of the typed characters.
			rl._writeToOutput = (s) => {
				if (s.includes(question)) rl.output.write(s);
				else rl.output.write(s.replace(/[^\r\n]/g, "*"));
			};
		}
		rl.question(`${question}${suffix}: `, (answer) => {
			rl.close();
			if (hidden) process.stdout.write("\n");
			resolve(answer.trim() || defaultValue || "");
		});
	});
}

async function confirm(question, defaultYes = true) {
	const a = (await ask(`${question} (${defaultYes ? "Y/n" : "y/N"})`)).toLowerCase();
	return a ? a.startsWith("y") : defaultYes;
}

function openBrowser(url) {
	try {
		const [cmd, args] = isWin
			? ["cmd", ["/c", "start", '""', url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
		spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }).unref();
	} catch {
		// Not fatal: the URL is printed too.
	}
}

function putSecret(name, value) {
	const res = wrangler(["secret", "put", name], { input: value });
	if (res.status !== 0) {
		console.error(red(`Could not set ${name}:`));
		console.error((res.stderr || res.stdout || "").trim());
		process.exit(1);
	}
	console.log(green(`✓ ${name} saved in Cloudflare`));
}

function existingSecrets() {
	const res = wrangler(["secret", "list", "--format", "json"], { capture: true });
	if (res.status !== 0) return new Set();
	try {
		return new Set(JSON.parse(res.stdout).map((s) => s.name));
	} catch {
		return new Set();
	}
}

function isValidTimezone(tz) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check an Oura client ID/secret pair without logging in: send a dummy code to
 * Oura's token endpoint. A valid pair gets 400 (bad code); a wrong pair gets 401.
 */
async function checkOuraCredentials(clientId, clientSecret, redirectUri) {
	try {
		const res = await fetch("https://api.ouraring.com/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: "setup-check",
				redirect_uri: redirectUri,
				client_id: clientId,
				client_secret: clientSecret,
			}),
		});
		if (res.status === 401) return "invalid";
		return "ok";
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------- steps

async function main() {
	console.log(bold("\nPersonal Oura MCP — setup\n"));
	console.log("This deploys your own private Oura server to Cloudflare (free plan) and configures it.");
	console.log("You can re-run it any time; it only asks for what is missing.\n");

	const [major] = process.versions.node.split(".").map(Number);
	if (major < 20) {
		console.error(red(`Node ${process.versions.node} is too old. Install Node 22 LTS from https://nodejs.org and try again.`));
		process.exit(1);
	}
	if (!existsSync("node_modules")) {
		console.error(red("Dependencies are missing. Run `npm install` first, then `npm run setup`."));
		process.exit(1);
	}

	// 1. Cloudflare login
	step(1, "Cloudflare login");
	const who = wrangler(["whoami"], { capture: true });
	if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
		console.log("A browser window will open. Log in to Cloudflare (or create a free account) and click Allow.");
		const login = wrangler(["login"]);
		if (login.status !== 0) {
			console.error(red("Cloudflare login failed. Run `npx wrangler login` and try again."));
			process.exit(1);
		}
	} else {
		console.log(green("✓ Already logged in to Cloudflare"));
	}

	// 2. Deploy (creates the KV store on first run)
	step(2, "Deploy the server");
	console.log("Deploying… (the first time, Wrangler may ask you to pick a workers.dev subdomain)\n");
	const outDir = mkdtempSync(join(tmpdir(), "oura-mcp-"));
	const outFile = join(outDir, "wrangler-output.ndjson");
	const deploy = wrangler(["deploy", "--x-auto-create"], { env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
	if (deploy.status !== 0) {
		console.error(red("\nDeploy failed. Read the error above, fix it, and run `npm run setup` again."));
		process.exit(1);
	}
	let baseUrl = "";
	try {
		for (const line of readFileSync(outFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry.type === "deploy" && Array.isArray(entry.targets)) {
				baseUrl = entry.targets.find((t) => /\.workers\.dev/.test(t)) ?? entry.targets[0] ?? "";
			}
		}
	} catch {
		// fall through to asking
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
	while (!/^https:\/\/[^\s/]+$/.test(baseUrl)) {
		baseUrl = (await ask("Paste your Worker URL shown above (https://personal-oura-mcp.<you>.workers.dev)")).replace(/\/+$/, "");
	}
	baseUrl = baseUrl.replace(/\/+$/, "");
	console.log(green(`✓ Live at ${baseUrl}`));
	// Remember the URL for `npm run doctor` (gitignored).
	writeFileSync(".oura-mcp.json", `${JSON.stringify({ url: baseUrl }, null, 2)}\n`);

	const secrets = existingSecrets();

	// 3. Oura developer app
	step(3, "Oura developer app");
	if (!reconfigure && secrets.has("OURA_CLIENT_ID") && secrets.has("OURA_CLIENT_SECRET")) {
		console.log(green("✓ Oura app credentials already set") + " (run with --reconfigure to change them)");
	} else {
		console.log(`Create a free Oura API application, filling in the form exactly like this:

  ${bold("Display Name")}       Personal Claude MCP
  ${bold("Description")}        Personal read-only access to my own Oura data from Claude. Single user.
  ${bold("Contact Email")}      your email
  ${bold("Website")}            ${baseUrl}
  ${bold("Privacy Policy")}     ${baseUrl}/privacy
  ${bold("Terms of Service")}   ${baseUrl}/terms
  ${bold("Redirect URIs")}      ${baseUrl}/callback
                     http://localhost:8788/callback   (optional, for local testing)
  ${bold("Scopes")}             tick: Personal, Daily, Heartrate, Workout, SpO2, Stress, Heart Health
                     untick: Email, Tag, Session, Ring Configuration

Then save, and copy the Client ID and Client Secret it shows you.
${yellow("Keep the Client Secret private: don't paste it into chats or screenshots.")}
`);
		const portal = "https://developer.ouraring.com/applications";
		if (await confirm(`Open ${portal} in your browser now?`)) openBrowser(portal);

		for (;;) {
			const clientId = await ask("Oura Client ID");
			const clientSecret = await ask("Oura Client Secret (typing is hidden)", { hidden: true });
			if (!clientId || !clientSecret) {
				console.log(yellow("Both values are needed."));
				continue;
			}
			const check = await checkOuraCredentials(clientId, clientSecret, `${baseUrl}/callback`);
			if (check === "invalid") {
				console.log(red("Oura rejected that Client ID / Secret pair (401 invalid_client)."));
				console.log("Copy both again from the Oura portal (regenerate the secret if unsure) and retry.");
				continue;
			}
			if (check === "unknown") console.log(yellow("Couldn't reach Oura to verify; saving anyway."));
			else console.log(green("✓ Oura accepted the credentials"));
			putSecret("OURA_CLIENT_ID", clientId);
			putSecret("OURA_CLIENT_SECRET", clientSecret);
			break;
		}
	}

	// 4. Timezone
	step(4, "Timezone for dates");
	if (!reconfigure && secrets.has("TIMEZONE")) {
		console.log(green("✓ Already set") + " (run with --reconfigure to change it)");
	} else {
		const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		let tz = "";
		while (!isValidTimezone(tz)) {
			tz = await ask("Your timezone (IANA name, e.g. Asia/Hong_Kong, Europe/London)", { defaultValue: detected });
			if (!isValidTimezone(tz)) console.log(yellow(`"${tz}" isn't a valid timezone name.`));
		}
		putSecret("TIMEZONE", tz);
	}

	// 5. Owner (allowlist)
	step(5, "Lock it to your Oura account");
	if (secrets.has("ALLOWED_OURA_USER_ID")) {
		console.log(green("✓ Already locked to an Oura account"));
	} else {
		const setupUrl = `${baseUrl}/setup`;
		console.log(`Open this page, sign in to Oura, and it will show your Oura user ID:\n\n  ${bold(setupUrl)}\n`);
		console.log("(Give it a few seconds after the previous step for the new settings to go live.)");
		if (await confirm("Open it in your browser now?")) openBrowser(setupUrl);
		let id = "";
		while (!id) id = (await ask("Paste your Oura user ID")).replace(/^["']|["']$/g, "").trim();
		putSecret("ALLOWED_OURA_USER_ID", id);
		console.log("Only this Oura account can connect now, and /setup has switched itself off.");
	}

	// Verify via the server's own status endpoint (booleans only).
	step(6, "Check");
	let ready = false;
	for (let attempt = 0; attempt < 5 && !ready; attempt++) {
		try {
			const res = await fetch(`${baseUrl}/status`, { headers: { Accept: "application/json" } });
			const status = await res.json();
			ready = status.ready === true;
			if (!ready && attempt === 4) console.log(yellow(`Not ready yet: ${status.next_step}`));
		} catch {
			// new settings can take a few seconds to go live
		}
		if (!ready) await new Promise((r) => setTimeout(r, 3000));
	}
	if (ready) console.log(green("✓ Server reports it is fully configured"));
	else console.log(yellow(`Couldn't confirm yet. Check ${baseUrl} in a browser, or run: npm run doctor`));

	// Done
	console.log(`\n${green(bold("All set!"))}

${bold("Add it to Claude")}
  1. On claude.ai (web): Settings → Connectors → Add custom connector
  2. Name: Oura
     URL:  ${bold(`${baseUrl}/mcp`)}
     Leave the OAuth / advanced fields empty.
  3. Click Connect → Continue to Oura → sign in and approve.
  4. In a chat, enable the Oura connector and ask: "How was my sleep this week?"
     It also works in the Claude mobile apps.

${bold("Later")}
  Health check: npm run doctor
  Update:      git pull && npm install && npm run deploy
  Change keys: npm run setup -- --reconfigure
  Remove:      npx wrangler delete   (and delete the app in the Oura developer portal)
`);
}

main().catch((err) => {
	console.error(red(err?.message ?? String(err)));
	process.exit(1);
});
