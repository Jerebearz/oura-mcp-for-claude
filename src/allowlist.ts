/**
 * Normalise an Oura user ID for comparison: Unicode-normalise, drop anything that
 * isn't a letter or digit (stray spaces, line breaks, quotes, dashes, zero-width
 * characters picked up when copying), lowercase.
 */
export function normalizeOuraUserId(value: string): string {
	return value.normalize("NFKC").replace(/[^0-9a-z]/gi, "").toLowerCase();
}

/** True only when ALLOWED_OURA_USER_ID is set and matches the Oura user ID. */
export function isAllowedOuraUser(env: { ALLOWED_OURA_USER_ID?: string }, ouraUserId: unknown): boolean {
	const allowed = normalizeOuraUserId(env.ALLOWED_OURA_USER_ID ?? "");
	if (allowed.length === 0 || allowed === "pending") return false;
	return typeof ouraUserId === "string" && normalizeOuraUserId(ouraUserId) === allowed;
}

/** A non-revealing hint about the configured ID, to help spot copy mistakes. */
export function describeAllowedId(env: { ALLOWED_OURA_USER_ID?: string }): string {
	const allowed = normalizeOuraUserId(env.ALLOWED_OURA_USER_ID ?? "");
	return `${allowed.length} letters/digits, ending in "${allowed.slice(-4)}"`;
}
