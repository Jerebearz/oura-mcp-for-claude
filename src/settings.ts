import { resolveTimezone } from "./dates";

const trim = (v: string | undefined) => (v ?? "").trim();

/** A setting counts as set when non-empty and not the "pending" placeholder (Deploy button). */
export function isSet(v: string | undefined): boolean {
	const t = trim(v);
	return t.length > 0 && t.toLowerCase() !== "pending";
}

export interface ConfigStatus {
	/** OURA_CLIENT_ID and OURA_CLIENT_SECRET are set. */
	ouraApp: boolean;
	/** ALLOWED_OURA_USER_ID is set (server locked to one Oura account). */
	owner: boolean;
	/** TIMEZONE is set to a valid IANA name (otherwise UTC is used). */
	timezoneSet: boolean;
	/** Effective timezone. */
	timezone: string;
}

/** Which settings are present. Booleans only: never expose values. */
export function configStatus(env: Env): ConfigStatus {
	const tz = trim(env.TIMEZONE);
	const resolved = resolveTimezone(tz);
	return {
		ouraApp: isSet(env.OURA_CLIENT_ID) && isSet(env.OURA_CLIENT_SECRET),
		owner: isSet(env.ALLOWED_OURA_USER_ID),
		timezoneSet: tz.length > 0 && resolved === tz,
		timezone: resolved,
	};
}

export function isFullyConfigured(s: ConfigStatus): boolean {
	return s.ouraApp && s.owner;
}

const COOKIE_KEY_KV = "config:cookie-signing-key";
let cachedCookieKey: string | undefined;

/**
 * Key for signing the "remembered consent" cookie. Uses COOKIE_ENCRYPTION_KEY if
 * set (32+ chars); otherwise generates one once and keeps it in KV, so users
 * don't have to create this secret themselves.
 */
export async function cookieSigningKey(env: Env): Promise<string> {
	const configured = trim(env.COOKIE_ENCRYPTION_KEY);
	if (configured.length >= 32) return configured;
	if (cachedCookieKey) return cachedCookieKey;
	let key = await env.OAUTH_KV.get(COOKIE_KEY_KV);
	if (!key) {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
		await env.OAUTH_KV.put(COOKIE_KEY_KV, key);
	}
	cachedCookieKey = key;
	return key;
}
