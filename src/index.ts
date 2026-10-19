import { OAuthError, OAuthProvider, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { isAllowedOuraUser } from "./allowlist";
import { authHandler } from "./auth-handler";
import { publicBaseUrl } from "./base-url";
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from "./config";
import { resolveTimezone } from "./dates";
import { OuraClient } from "./oura/client";
import { OuraTokenError, refreshTokens } from "./oura/tokens";
import { isProps, type Props } from "./props";
import { RateLimitedError, registerTools } from "./tools";
import { env as workerEnv } from "cloudflare:workers";

function currentProps(): Props {
	const props = getMcpAuthContext()?.props;
	if (!isProps(props) || !isAllowedOuraUser(workerEnv, props.ouraUserId)) {
		throw new Error("unauthorized");
	}
	return props;
}

function createServer(): McpServer {
	const timeZone = resolveTimezone(workerEnv.TIMEZONE);
	const server = new McpServer(
		{ name: "personal-oura-mcp", version: "0.2.0" },
		{
			instructions: `Read-only access to the user's own Oura Ring data. All dates are calendar days (YYYY-MM-DD) in ${timeZone}. Each tool defaults to the last 7 days and accepts at most 90 days per call.`,
		},
	);
	registerTools(server, {
		timeZone,
		getClient: () => new OuraClient(currentProps().ouraAccessToken),
		async checkRateLimit() {
			const { success } = await workerEnv.TOOL_RATE_LIMITER.limit({ key: currentProps().connectionId });
			if (!success) throw new RateLimitedError("Too many Oura requests from this connection. Wait a minute and try again.");
		},
	});
	return server;
}

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

/** Protected /mcp route. Re-checks the allowlist on every request as defence in depth. */
const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!isProps(ctx.props) || !isAllowedOuraUser(env, ctx.props.ouraUserId)) {
			return new Response("Forbidden", { status: 403 });
		}
		return mcpHandler(request, env, ctx);
	},
};

/** Seconds until the Oura access token expires. */
function ouraSecondsLeft(props: Props): number {
	return props.ouraExpiresAt - Math.floor(Date.now() / 1000);
}

/**
 * Keep the MCP access token no longer-lived than the Oura access token behind
 * it, and refresh Oura when the MCP client refreshes. Oura credentials only ever
 * live in encrypted grant props.
 */
async function tokenExchangeCallback(options: TokenExchangeCallbackOptions<Env>) {
	const env = options.env;
	const props = options.props as unknown;
	if (options.grantType !== "authorization_code" && options.grantType !== "refresh_token") return;
	if (!isProps(props) || !isAllowedOuraUser(env, props.ouraUserId)) {
		// Allowed user changed (or props are corrupt): revoke this grant.
		throw new OAuthError("invalid_grant", { description: "This connection is no longer authorized." });
	}

	let next: Props = props;
	// Refresh Oura if it would expire within the next MCP token lifetime (+5 min margin).
	if (options.grantType === "refresh_token" && ouraSecondsLeft(props) < MCP_ACCESS_TOKEN_TTL_SECONDS + 300) {
		try {
			const tokens = await refreshTokens({
				refreshToken: props.ouraRefreshToken,
				clientId: env.OURA_CLIENT_ID,
				clientSecret: env.OURA_CLIENT_SECRET,
			});
			next = {
				...props,
				ouraAccessToken: tokens.accessToken,
				ouraRefreshToken: tokens.refreshToken,
				ouraExpiresAt: tokens.expiresAt,
				ouraGrantedScopes: tokens.grantedScopes ?? props.ouraGrantedScopes,
			};
		} catch (err) {
			if (err instanceof OuraTokenError && err.terminal) {
				throw new OAuthError("invalid_grant", { description: "Oura access was revoked or expired. Reconnect." });
			}
			throw new OAuthError("temporarily_unavailable", {
				description: "Oura is temporarily unavailable.",
				statusCode: 503,
				headers: { "Retry-After": "60" },
			});
		}
	}

	const ttl = Math.max(60, Math.min(MCP_ACCESS_TOKEN_TTL_SECONDS, ouraSecondsLeft(next) - 60));
	return { newProps: next, accessTokenTTL: ttl };
}

// One provider per public origin (normally just one: the workers.dev URL).
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(env: Env, request: Request): OAuthProvider<Env> {
	const base = publicBaseUrl(env, request);
	let provider = providers.get(base);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler,
			defaultHandler: authHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			// Lets clients identify themselves by a metadata URL (MCP 2025-11+) as well as via DCR.
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: { resource: `${base}/mcp` },
			accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
			tokenExchangeCallback,
		});
		providers.set(base, provider);
	}
	return provider;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return getProvider(env, request).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
