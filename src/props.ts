/**
 * Grant props: encrypted by workers-oauth-provider and only decryptable with
 * the MCP token. Holds the Oura credentials for this connection.
 */
export interface Props {
	ouraUserId: string;
	ouraAccessToken: string;
	ouraRefreshToken: string;
	/** Epoch seconds when the Oura access token expires. */
	ouraExpiresAt: number;
	ouraGrantedScopes?: string[];
	/** Random per-connection ID, used as the rate-limit key. */
	connectionId: string;
	[key: string]: unknown;
}

export function isProps(value: unknown): value is Props {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.ouraUserId === "string" &&
		typeof p.ouraAccessToken === "string" &&
		typeof p.ouraRefreshToken === "string" &&
		typeof p.ouraExpiresAt === "number" &&
		typeof p.connectionId === "string"
	);
}
