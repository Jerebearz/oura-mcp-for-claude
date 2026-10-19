import { describe, expect, it } from "vitest";
import { isAllowedOuraUser } from "../src/allowlist";
import { renderHomePage } from "../src/consent-page";
import { configStatus, cookieSigningKey, isFullyConfigured } from "../src/settings";

const env = (vars: Record<string, string | undefined>, kv = new Map<string, string>()) =>
	({
		...vars,
		OAUTH_KV: {
			get: async (k: string) => kv.get(k) ?? null,
			put: async (k: string, v: string) => void kv.set(k, v),
		},
	}) as unknown as Env;

describe("configStatus", () => {
	it("reports booleans only", () => {
		const s = configStatus(env({ OURA_CLIENT_ID: "id", OURA_CLIENT_SECRET: " ", TIMEZONE: "Asia/Hong_Kong" }));
		expect(s).toEqual({ ouraApp: false, owner: false, timezoneSet: true, timezone: "Asia/Hong_Kong" });
		const full = configStatus(env({ OURA_CLIENT_ID: "id", OURA_CLIENT_SECRET: "sec", ALLOWED_OURA_USER_ID: "u" }));
		expect(isFullyConfigured(full)).toBe(true);
		expect(full.timezone).toBe("UTC");
		expect(full.timezoneSet).toBe(false);
		expect(configStatus(env({ TIMEZONE: "Not/AZone" })).timezoneSet).toBe(false);
	});
});

describe("pending placeholder", () => {
	it("treats `pending` (from the Deploy button) as not set", () => {
		const s = configStatus(env({ OURA_CLIENT_ID: "pending", OURA_CLIENT_SECRET: "Pending", ALLOWED_OURA_USER_ID: "pending" }));
		expect(s.ouraApp).toBe(false);
		expect(s.owner).toBe(false);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "pending" }, "pending")).toBe(false);
	});
});

describe("cookieSigningKey", () => {
	it("prefers COOKIE_ENCRYPTION_KEY when long enough", async () => {
		const k = "x".repeat(40);
		expect(await cookieSigningKey(env({ COOKIE_ENCRYPTION_KEY: k }))).toBe(k);
	});
});

describe("home page", () => {
	const base = {
		baseUrl: "https://personal-oura-mcp.me.workers.dev",
		version: "0.3.0",
		repoUrl: "https://github.com/x/y",
		timezone: "UTC",
		timezoneSet: false,
	};
	it("shows a setup checklist with this deployment's Oura form values when unconfigured", () => {
		const html = renderHomePage({ ...base, ouraApp: false, owner: false });
		expect(html).toContain("finish setup");
		expect(html).toContain("https://personal-oura-mcp.me.workers.dev/callback");
		expect(html).toContain("https://personal-oura-mcp.me.workers.dev/privacy");
		expect(html).toContain("Available after step 1");
	});
	it("links to /setup once the Oura app is configured", () => {
		expect(renderHomePage({ ...base, ouraApp: true, owner: false })).toContain('href="/setup"');
	});
	it("shows just the connector URL when ready", () => {
		const html = renderHomePage({ ...base, ouraApp: true, owner: true });
		expect(html).not.toContain("finish setup");
		expect(html).toContain("https://personal-oura-mcp.me.workers.dev/mcp");
	});
	it("escapes the base URL", () => {
		expect(renderHomePage({ ...base, baseUrl: 'https://a"<b>', ouraApp: false, owner: false })).not.toContain('"<b>');
	});
});
