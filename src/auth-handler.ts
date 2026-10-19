import {
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
	type AuthRequest,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describeAllowedId, isAllowedOuraUser } from "./allowlist";
import { publicBaseUrl } from "./base-url";
import { OURA_AUTHORIZE_URL, OURA_SCOPES } from "./config";
import {
	htmlHeaders,
	renderConsentPage,
	renderErrorPage,
	renderHomePage,
	renderOuraIdPage,
	renderStaticPage,
} from "./consent-page";
import { OuraApiError, OuraClient } from "./oura/client";
import { exchangeCode, OuraTokenError, type OuraTokens } from "./oura/tokens";
import type { Props } from "./props";
import { configStatus, cookieSigningKey, isSet } from "./settings";
import { REPO_URL, VERSION } from "./version";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

function errorPage(status: number, title: string, message: string, headers?: Headers): Response {
	return new Response(renderErrorPage(title, message), { status, headers: htmlHeaders(headers) });
}

async function rememberOptions(env: Env) {
	return { secret: await cookieSigningKey(env) };
}

function callbackUrl(env: Env, request: Request): string {
	return `${publicBaseUrl(env, request)}/callback`;
}

function isOwnerConfigured(env: Env): boolean {
	return isSet(env.ALLOWED_OURA_USER_ID);
}

function ouraAuthorizeUrl(env: Env, request: Request, state: string, scopes: readonly string[]): string {
	const url = new URL(OURA_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", (env.OURA_CLIENT_ID ?? "").trim());
	url.searchParams.set("redirect_uri", callbackUrl(env, request));
	url.searchParams.set("scope", scopes.join(" "));
	url.searchParams.set("state", state);
	return url.href;
}

/** Redirect the browser to Oura's login/consent page. Only call after our own consent step. */
async function redirectToOura(
	oauth: OAuthHelpers,
	env: Env,
	request: Request,
	authRequest: AuthRequest,
	headers?: Headers,
) {
	const { state, headers: out } = await oauth.beginUpstream(authRequest, { headers });
	out.set("Location", ouraAuthorizeUrl(env, request, state, OURA_SCOPES));
	out.set("Cache-Control", "no-store");
	return new Response(null, { status: 302, headers: out });
}

/** Exchange an Oura authorization code and read the account's user ID. Returns an error page on failure. */
async function identifyOuraUser(
	code: string,
	env: Env,
	request: Request,
	headers: Headers,
): Promise<{ tokens: OuraTokens; ouraUserId: string } | Response> {
	let tokens: OuraTokens;
	try {
		tokens = await exchangeCode({
			code,
			redirectUri: callbackUrl(env, request),
			clientId: env.OURA_CLIENT_ID ?? "",
			clientSecret: env.OURA_CLIENT_SECRET ?? "",
		});
	} catch (err) {
		if (err instanceof OuraTokenError) {
			return errorPage(
				502,
				"Oura sign-in failed",
				"Could not exchange the Oura authorization code. If this keeps happening, check that OURA_CLIENT_ID and OURA_CLIENT_SECRET match your Oura app.",
				headers,
			);
		}
		throw err;
	}
	try {
		const id = (await new OuraClient(tokens.accessToken).personalInfo()).id;
		if (typeof id !== "string" || !id) {
			return errorPage(502, "Oura sign-in failed", "Oura did not return a user ID.", headers);
		}
		return { tokens, ouraUserId: id };
	} catch (err) {
		if (err instanceof OuraApiError) {
			return errorPage(502, "Oura sign-in failed", `Could not read your Oura user ID: ${err.message}`, headers);
		}
		throw err;
	}
}

async function getAuthorize(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	if (await oauth.isConsentRemembered(request, authRequest, await rememberOptions(env))) {
		return redirectToOura(oauth, env, request, authRequest);
	}
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	return new Response(renderConsentPage(details, consent.handle), { headers: htmlHeaders(consent.headers) });
}

async function postAuthorize(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(request, handle, { remember: await rememberOptions(env) });
	return redirectToOura(oauth, env, request, approved.request, approved.headers);
}

async function getCallback(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const { request: original, headers } = await oauth.finishUpstream(request);
	const params = new URL(request.url).searchParams;

	const redirectError = (description: string) => {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
		return new Response(null, { status: 302, headers });
	};

	if (params.get("error")) return redirectError("Oura sign-in was cancelled or failed.");
	const code = params.get("code");
	if (!code) return redirectError("Oura did not return an authorization code.");

	const result = await identifyOuraUser(code, env, request, headers);
	if (result instanceof Response) return result;
	const { tokens, ouraUserId } = result;

	if (!isOwnerConfigured(env)) {
		// Setup mode: no allowlist yet. Reject, but show the signed-in account its own ID
		// so the owner can set ALLOWED_OURA_USER_ID. Nothing is stored.
		return new Response(
			renderOuraIdPage(
				"Setup: allowlist not configured",
				ouraUserId,
				"No ALLOWED_OURA_USER_ID is set yet, so nobody can connect.",
				'Set it with "npx wrangler secret put ALLOWED_OURA_USER_ID" (or in the setup script), then connect again.',
			),
			{ status: 403, headers: htmlHeaders(headers) },
		);
	}

	if (!isAllowedOuraUser(env, ouraUserId)) {
		// Do not store anything or issue an MCP token. The Oura tokens just obtained are dropped.
		// Show the signed-in account its own ID plus a short hint about the configured one,
		// so a copy/paste mismatch is easy to spot.
		console.warn("callback: rejected Oura account not on allowlist");
		return errorPage(
			403,
			"Access denied",
			`This Oura account is not allowed to use this server. You signed in as Oura user ID: ${ouraUserId}. The server's ALLOWED_OURA_USER_ID has ${describeAllowedId(env)}.`,
			headers,
		);
	}

	const props: Props = {
		ouraUserId,
		ouraAccessToken: tokens.accessToken,
		ouraRefreshToken: tokens.refreshToken,
		ouraExpiresAt: tokens.expiresAt,
		ouraGrantedScopes: tokens.grantedScopes,
		connectionId: crypto.randomUUID(),
	};

	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: encodeURIComponent(props.ouraUserId),
		metadata: { label: "Oura" },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

// --- One-time owner setup -------------------------------------------------
// While ALLOWED_OURA_USER_ID is unset, GET /setup signs in with Oura (scope
// `personal` only) and shows the account its own user ID so the owner can
// configure the allowlist. Nothing is stored. Once the ID is set, /setup is off.

const SETUP_COOKIE = "__Host-oura-setup";

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return undefined;
}

function getSetup(request: Request, env: Env): Response {
	if (isOwnerConfigured(env)) {
		return errorPage(404, "Already set up", "This server already has an owner, so setup is turned off.");
	}
	if (!isSet(env.OURA_CLIENT_ID) || !isSet(env.OURA_CLIENT_SECRET)) {
		return errorPage(
			503,
			"Setup not ready",
			"OURA_CLIENT_ID and OURA_CLIENT_SECRET are not set yet. Run the setup script (npm run setup) or set them with wrangler secret put.",
		);
	}
	const state = crypto.randomUUID();
	const headers = new Headers({
		Location: ouraAuthorizeUrl(env, request, state, ["personal"]),
		"Cache-Control": "no-store",
		"Set-Cookie": `${SETUP_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
	});
	return new Response(null, { status: 302, headers });
}

async function finishSetup(request: Request, env: Env): Promise<Response> {
	const headers = new Headers({
		"Set-Cookie": `${SETUP_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
	});
	if (isOwnerConfigured(env)) {
		return errorPage(404, "Already set up", "This server already has an owner, so setup is turned off.", headers);
	}
	const params = new URL(request.url).searchParams;
	const code = params.get("code");
	if (params.get("error") || !code) {
		return errorPage(400, "Oura sign-in cancelled", "Open /setup again to retry.", headers);
	}
	const result = await identifyOuraUser(code, env, request, headers);
	if (result instanceof Response) return result;
	return new Response(
		renderOuraIdPage(
			"Your Oura user ID",
			result.ouraUserId,
			"Sign-in worked. Nothing was stored; this page only shows you your own ID.",
			"Paste it into the setup script when it asks (or run: npx wrangler secret put ALLOWED_OURA_USER_ID). After that, setup turns itself off and only this Oura account can connect.",
		),
		{ status: 200, headers: htmlHeaders(headers) },
	);
}

// --- Home page and machine-readable status -------------------------------
// Both report only which settings exist (booleans), never their values.

function homePage(request: Request, env: Env): Response {
	const status = configStatus(env);
	return new Response(
		renderHomePage({ baseUrl: publicBaseUrl(env, request), version: VERSION, repoUrl: REPO_URL, ...status }),
		{ headers: htmlHeaders() },
	);
}

function statusJson(request: Request, env: Env): Response {
	const base = publicBaseUrl(env, request);
	const s = configStatus(env);
	const next = !s.ouraApp
		? "Create the Oura app (see oura_app_form) and set secrets OURA_CLIENT_ID and OURA_CLIENT_SECRET."
		: !s.owner
			? `Open ${base}/setup, sign in to Oura, and set the secret ALLOWED_OURA_USER_ID to the ID shown.`
			: `Ready. Add ${base}/mcp as a custom connector in Claude.`;
	const body = {
		name: "oura-mcp-for-claude",
		version: VERSION,
		source: REPO_URL,
		ready: s.ouraApp && s.owner,
		checks: { oura_app_credentials: s.ouraApp, owner_locked: s.owner, timezone_set: s.timezoneSet },
		timezone: s.timezone,
		mcp_url: `${base}/mcp`,
		setup_url: s.owner ? null : `${base}/setup`,
		oura_app_form: {
			website: base,
			privacy_policy: `${base}/privacy`,
			terms_of_service: `${base}/terms`,
			redirect_uri: `${base}/callback`,
			scopes: [...OURA_SCOPES],
		},
		next_step: next,
	};
	return new Response(JSON.stringify(body, null, 2), {
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/**
 * Unprotected routes: the OAuth flow (/authorize, /callback), one-time owner
 * setup (/setup, off once ALLOWED_OURA_USER_ID is set), the home page (setup
 * checklist until configured), /status (JSON, booleans only), and the
 * privacy/terms pages that the Oura developer app form asks for. `/token`, `/register`
 * and `.well-known/*` are served by the OAuth provider itself.
 */
export const authHandler = {
	async fetch(request: Request, baseEnv: Env): Promise<Response> {
		const env = baseEnv as AuthEnv;
		const { pathname, searchParams } = new URL(request.url);
		try {
			if (pathname === "/authorize" && request.method === "GET") return await getAuthorize(request, env);
			if (pathname === "/authorize" && request.method === "POST") return await postAuthorize(request, env);
			if (pathname === "/callback" && request.method === "GET") {
				const setupState = readCookie(request, SETUP_COOKIE);
				if (setupState && setupState === searchParams.get("state")) return await finishSetup(request, env);
				return await getCallback(request, env);
			}
			if (pathname === "/setup" && request.method === "GET") return getSetup(request, env);
			if (request.method === "GET" && (pathname === "/privacy" || pathname === "/terms")) {
				return new Response(renderStaticPage(pathname === "/privacy" ? "privacy" : "terms"), { headers: htmlHeaders() });
			}
			if (request.method === "GET" && pathname === "/") return homePage(request, env);
			if (request.method === "GET" && pathname === "/status") return statusJson(request, env);
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) {
				return Response.redirect(error.redirectTo, 302);
			}
			if (error instanceof AuthorizationError) {
				return errorPage(400, "Authorization failed", `${error.description} Start connecting again from Claude.`);
			}
			if (error instanceof CimdFetchError) {
				return errorPage(400, "Authorization failed", "This app could not be verified.");
			}
			throw error;
		}
		return new Response("Not found", { status: 404 });
	},
};
