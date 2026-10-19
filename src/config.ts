/** Oura OAuth endpoints. Authorize lives on cloud.ouraring.com, tokens on api.ouraring.com. */
export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
export const OURA_API_BASE = "https://api.ouraring.com";

/**
 * Minimum Oura scopes for the tools this server exposes.
 *
 * - personal:     personal_info (used once at login to read the Oura user ID)
 * - daily:        daily_readiness, daily_sleep, sleep, daily_activity, daily_stress
 * - heartrate:    heartrate
 * - workout:      workout
 * - spo2:         daily_spo2
 * - stress:       daily_resilience
 * - heart_health: vO2_max, daily_cardiovascular_age
 *
 * Oura silently drops scopes it does not recognise (or that the app has not
 * enabled), so the granted list is checked at login.
 */
export const OURA_SCOPES = ["personal", "daily", "heartrate", "workout", "spo2", "stress", "heart_health"] as const;

/** Oura reports granted scopes with this prefix (e.g. `extapi:daily`). */
export const OURA_GRANTED_SCOPE_PREFIX = "extapi:";

/** Timezone used to interpret start_date / end_date when TIMEZONE is not set. */
export const DEFAULT_TIMEZONE = "UTC";

export const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 90;

/** Upper bound on the MCP access token lifetime; Oura is refreshed ahead of this window. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 3600;

/** Upstream request timeout. */
export const OURA_TIMEOUT_MS = 15_000;
