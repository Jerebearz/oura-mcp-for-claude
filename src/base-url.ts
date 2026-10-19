/**
 * Public origin of this Worker, used for the OAuth resource URL and the Oura
 * redirect URI. Defaults to the origin the request arrived on (Workers only
 * receive requests for their own routes, e.g. <name>.<subdomain>.workers.dev).
 * Set PUBLIC_BASE_URL to pin it, e.g. for a custom domain, or locally to
 * http://localhost:8788 so 127.0.0.1 and localhost behave the same.
 */
export function publicBaseUrl(env: { PUBLIC_BASE_URL?: string }, request: Request): string {
	const configured = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
	return configured || new URL(request.url).origin;
}
