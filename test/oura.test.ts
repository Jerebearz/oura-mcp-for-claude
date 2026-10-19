import { describe, expect, it, vi } from "vitest";
import { OuraApiError, OuraClient } from "../src/oura/client";
import { exchangeCode, OuraTokenError, parseGrantedScopes, refreshTokens } from "../src/oura/tokens";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("OuraClient", () => {
	it("follows next_token pagination and sends the bearer token", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ data: [{ day: "a" }], next_token: "t1" }))
			.mockResolvedValueOnce(json({ data: [{ day: "b" }], next_token: null }));
		const docs = await new OuraClient("tok", fetcher as unknown as typeof fetch).list("daily_sleep", { start_date: "2026-01-01" });
		expect(docs).toEqual([{ day: "a" }, { day: "b" }]);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const [url1, init1] = fetcher.mock.calls[0];
		expect(url1).toBe("https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=2026-01-01");
		expect(init1.headers.Authorization).toBe("Bearer tok");
		expect(fetcher.mock.calls[1][0]).toContain("next_token=t1");
	});

	it("maps 429 to a readable message with retry hint", async () => {
		const fetcher = vi.fn().mockResolvedValue(json({ detail: "Too many" }, 429, { "retry-after": "30" }));
		const err = await new OuraClient("tok", fetcher as unknown as typeof fetch).list("sleep", {}).catch((e) => e);
		expect(err).toBeInstanceOf(OuraApiError);
		expect(err.status).toBe(429);
		expect(err.message).toMatch(/rate limit.*30 seconds/);
	});

	it("maps 401 and 403 and never includes the token", async () => {
		for (const status of [401, 403]) {
			const fetcher = vi.fn().mockResolvedValue(json({ detail: "nope" }, status));
			const err = await new OuraClient("secret-token", fetcher as unknown as typeof fetch).list("sleep", {}).catch((e) => e);
			expect(err.status).toBe(status);
			expect(err.message).not.toContain("secret-token");
		}
	});

	it("reports network failures", async () => {
		const fetcher = vi.fn().mockRejectedValue(new TypeError("boom"));
		const err = await new OuraClient("t", fetcher as unknown as typeof fetch).list("sleep", {}).catch((e) => e);
		expect(err).toBeInstanceOf(OuraApiError);
		expect(err.message).toMatch(/Could not reach/);
	});
});

describe("Oura tokens", () => {
	it("exchanges a code with client_secret_post and strips scope prefixes", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			json({ access_token: "a", refresh_token: "r", expires_in: 86400, scope: "extapi:daily extapi:heartrate" }),
		);
		const t = await exchangeCode(
			{ code: "c", redirectUri: "https://x/callback", clientId: "id", clientSecret: "sec" },
			fetcher as unknown as typeof fetch,
		);
		expect(t.accessToken).toBe("a");
		expect(t.refreshToken).toBe("r");
		expect(t.grantedScopes).toEqual(["daily", "heartrate"]);
		expect(t.expiresAt).toBeGreaterThan(Date.now() / 1000 + 86000);
		const body = new URLSearchParams(fetcher.mock.calls[0][1].body);
		expect(Object.fromEntries(body)).toEqual({
			grant_type: "authorization_code",
			code: "c",
			redirect_uri: "https://x/callback",
			client_id: "id",
			client_secret: "sec",
		});
	});

	it("treats invalid_grant on refresh as terminal and 5xx as transient", async () => {
		const bad = vi.fn().mockResolvedValue(json({ error: "invalid_grant" }, 400));
		const e1 = await refreshTokens({ refreshToken: "r", clientId: "i", clientSecret: "s" }, bad as unknown as typeof fetch).catch((e) => e);
		expect(e1).toBeInstanceOf(OuraTokenError);
		expect(e1.terminal).toBe(true);
		const down = vi.fn().mockResolvedValue(json({}, 503));
		const e2 = await refreshTokens({ refreshToken: "r", clientId: "i", clientSecret: "s" }, down as unknown as typeof fetch).catch((e) => e);
		expect(e2.terminal).toBe(false);
	});

	it("parses scope strings", () => {
		expect(parseGrantedScopes(undefined)).toBeUndefined();
		expect(parseGrantedScopes("personal extapi:spo2")).toEqual(["personal", "spo2"]);
	});
});

describe("Oura token client auth", () => {
	it("trims credentials and falls back to HTTP Basic on invalid_client", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ error: "invalid_client" }, 401))
			.mockResolvedValueOnce(json({ access_token: "a", refresh_token: "r", expires_in: 100 }));
		const t = await exchangeCode(
			{ code: "c", redirectUri: "https://x/callback", clientId: " id \n", clientSecret: "sec\r\n" },
			fetcher as unknown as typeof fetch,
		);
		expect(t.accessToken).toBe("a");
		const first = new URLSearchParams(fetcher.mock.calls[0][1].body);
		expect(first.get("client_id")).toBe("id");
		expect(first.get("client_secret")).toBe("sec");
		const second = fetcher.mock.calls[1][1];
		expect(second.headers.Authorization).toBe(`Basic ${btoa("id:sec")}`);
		const secondBody = new URLSearchParams(second.body);
		expect(secondBody.get("client_secret")).toBeNull();
		expect(secondBody.get("code")).toBe("c");
	});

	it("still fails clearly when both methods are rejected", async () => {
		const fetcher = vi.fn().mockResolvedValue(json({ error: "invalid_client" }, 401));
		const err = await exchangeCode(
			{ code: "c", redirectUri: "r", clientId: "id", clientSecret: "bad" },
			fetcher as unknown as typeof fetch,
		).catch((e) => e);
		expect(err).toBeInstanceOf(OuraTokenError);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe("OuraClient fetch binding", () => {
	it("never calls fetch with `this` bound to the client (Workers: Illegal invocation)", async () => {
		const strictFetch = function (this: unknown) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(json({ id: "u1" }));
		} as unknown as typeof fetch;
		const info = await new OuraClient("tok", strictFetch).personalInfo();
		expect(info.id).toBe("u1");
	});

	it("default fetcher calls global fetch unbound", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = function (this: unknown) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(json({ id: "u2" }));
		} as unknown as typeof fetch;
		try {
			expect((await new OuraClient("tok").personalInfo()).id).toBe("u2");
		} finally {
			globalThis.fetch = original;
		}
	});
});
