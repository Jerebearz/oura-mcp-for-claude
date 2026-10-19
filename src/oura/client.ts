import { OURA_API_BASE, OURA_TIMEOUT_MS } from "../config";

/** An Oura API failure with a message that is safe to show to the user (no tokens, no health data). */
export class OuraApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "OuraApiError";
	}
}

/** Map an Oura HTTP status to a readable explanation. `detail` is Oura's own error text, if any. */
export function describeOuraError(status: number, detail?: string, retryAfter?: number): string {
	const suffix = detail ? ` (Oura says: ${detail})` : "";
	switch (status) {
		case 400:
		case 422:
			return `Oura rejected the request parameters${suffix}.`;
		case 401:
			return `Oura rejected the access token. The connection may have been revoked or a required scope was not granted. Reconnect the Oura connector in Claude settings${suffix}.`;
		case 403:
			return `Oura denied access. This usually means the Oura membership is inactive or this data type's scope was not granted${suffix}.`;
		case 404:
			return `Oura has no such resource${suffix}.`;
		case 429:
			return `Oura rate limit reached. Try again${retryAfter ? ` in about ${retryAfter} seconds` : " in a few minutes"}.`;
		default:
			if (status >= 500) return `Oura's API is having problems (HTTP ${status}). Try again shortly.`;
			return `Oura request failed with HTTP ${status}${suffix}.`;
	}
}

/** Oura errors are FastAPI-style: `detail` is a string or a list of `{ msg }`. */
export function extractOuraDetail(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const obj = payload as Record<string, unknown>;
	const detail = obj.detail;
	if (typeof detail === "string") return detail.slice(0, 300);
	if (Array.isArray(detail)) {
		const msgs = detail
			.map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).msg : undefined))
			.filter((m): m is string => typeof m === "string");
		if (msgs.length) return msgs.join("; ").slice(0, 300);
	}
	for (const key of ["message", "title", "error_description"]) {
		if (typeof obj[key] === "string") return (obj[key] as string).slice(0, 300);
	}
	return undefined;
}

export interface OuraListResponse {
	data: Record<string, unknown>[];
	next_token?: string | null;
}

const MAX_PAGES = 50;

/** Minimal read-only Oura API v2 client. Never logs request or response bodies. */
export class OuraClient {
	constructor(
		private readonly accessToken: string,
		// Wrapped so `fetch` is never invoked with `this` bound to the client:
		// Workers throws "Illegal invocation" for that.
		private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
	) {}

	async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
		const url = new URL(path, OURA_API_BASE);
		for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

		const fetcher = this.fetcher;
		let res: Response;
		try {
			res = await fetcher(url.toString(), {
				method: "GET",
				headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
				signal: AbortSignal.timeout(OURA_TIMEOUT_MS),
			});
		} catch (err) {
			const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
			console.error(`oura ${path}: ${timedOut ? "timeout" : `network error (${err instanceof Error ? err.name : "unknown"})`}`);
			throw new OuraApiError(
				504,
				timedOut ? "Oura did not respond in time. Try again shortly." : "Could not reach Oura's API. Try again shortly.",
			);
		}

		if (!res.ok) {
			let payload: unknown;
			try {
				payload = await res.json();
			} catch {
				payload = undefined;
			}
			const retryAfterHeader = res.headers.get("retry-after");
			const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
			// Log status only: never the body, which may echo request data.
			console.error(`oura ${path}: HTTP ${res.status}`);
			throw new OuraApiError(res.status, describeOuraError(res.status, extractOuraDetail(payload), retryAfter), retryAfter);
		}

		try {
			return await res.json();
		} catch {
			throw new OuraApiError(502, "Oura returned a response that could not be parsed.");
		}
	}

	/** Fetch every page of a usercollection list endpoint. */
	async list(collection: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		let nextToken: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const q = nextToken ? { ...query, next_token: nextToken } : query;
			const body = (await this.get(`/v2/usercollection/${collection}`, q)) as OuraListResponse;
			if (!body || !Array.isArray(body.data)) {
				throw new OuraApiError(502, `Oura returned an unexpected response for ${collection}.`);
			}
			out.push(...body.data);
			nextToken = body.next_token ?? undefined;
			if (!nextToken) return out;
		}
		return out;
	}

	async personalInfo(): Promise<Record<string, unknown>> {
		return (await this.get("/v2/usercollection/personal_info")) as Record<string, unknown>;
	}
}
