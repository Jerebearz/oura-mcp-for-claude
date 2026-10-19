import { OURA_GRANTED_SCOPE_PREFIX, OURA_TOKEN_URL, OURA_TIMEOUT_MS } from "../config";

export interface OuraTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch seconds. */
	expiresAt: number;
	/** Scopes Oura actually granted (prefix stripped), if it reported them. */
	grantedScopes?: string[];
}

export class OuraTokenError extends Error {
	constructor(
		/** true when the refresh token is permanently invalid (revoked, already used, expired). */
		public readonly terminal: boolean,
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "OuraTokenError";
	}
}

export function parseGrantedScopes(scope: unknown): string[] | undefined {
	if (typeof scope !== "string" || !scope.trim()) return undefined;
	return scope
		.split(/\s+/)
		.filter(Boolean)
		.map((s) => (s.startsWith(OURA_GRANTED_SCOPE_PREFIX) ? s.slice(OURA_GRANTED_SCOPE_PREFIX.length) : s));
}

type TokenParams = Record<string, string> & { client_id: string; client_secret: string };

async function sendTokenRequest(
	params: TokenParams,
	auth: "post" | "basic",
	fetcher: typeof fetch,
): Promise<{ res: Response; body: Record<string, unknown> }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	const form: Record<string, string> = { ...params };
	if (auth === "basic") {
		// RFC 6749 §2.3.1: credentials in the Authorization header, not the body.
		delete form.client_secret;
		delete form.client_id;
		headers.Authorization = `Basic ${btoa(`${encodeURIComponent(params.client_id)}:${encodeURIComponent(params.client_secret)}`)}`;
	}
	let res: Response;
	try {
		res = await fetcher(OURA_TOKEN_URL, {
			method: "POST",
			headers,
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(OURA_TIMEOUT_MS),
		});
	} catch {
		console.error("oura token endpoint: network error");
		throw new OuraTokenError(false, "Could not reach Oura's token endpoint.", 503);
	}
	let body: Record<string, unknown> = {};
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		// fall through with empty body
	}
	return { res, body };
}

async function postToken(rawParams: TokenParams, fetcher: typeof fetch): Promise<OuraTokens> {
	// Stray whitespace from copy/paste into .dev.vars or `wrangler secret put` breaks client auth.
	const params: TokenParams = {
		...rawParams,
		client_id: rawParams.client_id.trim(),
		client_secret: rawParams.client_secret.trim(),
	};

	let { res, body } = await sendTokenRequest(params, "post", fetcher);
	if (res.status === 401 && body.error === "invalid_client") {
		// Client authentication fails before the code is consumed, so retrying with
		// HTTP Basic credentials is safe.
		console.error("oura token endpoint: HTTP 401 invalid_client (client_secret_post), retrying with HTTP Basic");
		({ res, body } = await sendTokenRequest(params, "basic", fetcher));
	}

	if (!res.ok) {
		const error = typeof body.error === "string" ? body.error : undefined;
		console.error(`oura token endpoint: HTTP ${res.status}${error ? ` ${error}` : ""}`);
		const terminal = error === "invalid_grant" || error === "unauthorized_client" || res.status === 401;
		throw new OuraTokenError(
			terminal,
			terminal ? "Oura access was revoked or has expired." : `Oura token request failed (HTTP ${res.status}).`,
			res.status,
		);
	}

	const accessToken = body.access_token;
	const refreshToken = body.refresh_token;
	if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
		throw new OuraTokenError(false, "Oura token response was missing tokens.", 502);
	}
	// If Oura omits expires_in, assume one hour so we refresh conservatively.
	const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
	return {
		accessToken,
		refreshToken,
		expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
		grantedScopes: parseGrantedScopes(body.scope),
	};
}

export function exchangeCode(
	opts: { code: string; redirectUri: string; clientId: string; clientSecret: string },
	fetcher: typeof fetch = fetch,
): Promise<OuraTokens> {
	return postToken(
		{
			grant_type: "authorization_code",
			code: opts.code,
			redirect_uri: opts.redirectUri,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
		},
		fetcher,
	);
}

/** Oura refresh tokens are treated as single-use: always persist the returned refresh token. */
export function refreshTokens(
	opts: { refreshToken: string; clientId: string; clientSecret: string },
	fetcher: typeof fetch = fetch,
): Promise<OuraTokens> {
	return postToken(
		{
			grant_type: "refresh_token",
			refresh_token: opts.refreshToken,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
		},
		fetcher,
	);
}
