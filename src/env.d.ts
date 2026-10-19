// Optional settings that the Deploy to Cloudflare button does not prompt for
// (the button prompts for the keys in .dev.vars.example). Set them later with
// `npx wrangler secret put <NAME>` or in the Cloudflare dashboard.
interface OptionalOuraMcpSettings {
	/** Your Oura user ID. Until set, nobody can connect; /setup shows you the ID. */
	ALLOWED_OURA_USER_ID?: string;
	/** Optional: signs the "remembered consent" cookie. Auto-generated and kept in KV if unset. */
	COOKIE_ENCRYPTION_KEY?: string;
	/** Optional: pin the public origin (custom domain, or http://localhost:8788 locally). */
	PUBLIC_BASE_URL?: string;
}

interface Env extends OptionalOuraMcpSettings {}

declare namespace Cloudflare {
	interface Env extends OptionalOuraMcpSettings {}
}
