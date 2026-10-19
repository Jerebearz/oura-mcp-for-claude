import { describe, expect, it, vi } from "vitest";
import { OuraApiError, OuraClient } from "../src/oura/client";
import { RateLimitedError, registerTools, TOOL_NAMES } from "../src/tools";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function setup(listImpl: (collection: string, query: Record<string, string>) => Promise<Record<string, unknown>[]>, rateOk = true) {
	const handlers = new Map<string, Handler>();
	const configs = new Map<string, { annotations?: { readOnlyHint?: boolean } }>();
	const server = {
		registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }, cb: Handler) => {
			handlers.set(name, cb);
			configs.set(name, config);
		},
	};
	const list = vi.fn(listImpl);
	const client = { list } as unknown as OuraClient;
	registerTools(server as never, {
		timeZone: "Asia/Hong_Kong",
		getClient: () => client,
		checkRateLimit: async () => {
			if (!rateOk) throw new RateLimitedError("slow down");
		},
	});
	return { handlers, configs, list };
}

describe("tools", () => {
	it("registers every tool as read-only", () => {
		const { handlers, configs } = setup(async () => []);
		expect([...handlers.keys()].sort()).toEqual([...TOOL_NAMES].sort());
		expect(TOOL_NAMES).toEqual(
			expect.arrayContaining([
				"get_daily_readiness",
				"get_daily_sleep",
				"get_sleep_sessions",
				"get_daily_activity",
				"get_heart_rate",
				"get_workouts",
				"get_daily_stress",
				"get_daily_resilience",
				"get_daily_spo2",
				"get_vo2_max",
				"get_cardiovascular_age",
			]),
		);
		for (const c of configs.values()) expect(c.annotations?.readOnlyHint).toBe(true);
	});

	it("queries one extra day and filters to the requested range", async () => {
		const { handlers, list } = setup(async () => [
			{ day: "2026-10-01", score: 80, id: "a" },
			{ day: "2026-10-02", score: 70, id: "b" },
		]);
		const res = await handlers.get("get_daily_readiness")!({ start_date: "2026-10-01", end_date: "2026-10-01" });
		expect(list).toHaveBeenCalledWith("daily_readiness", { start_date: "2026-10-01", end_date: "2026-10-02" });
		const body = JSON.parse(res.content[0].text);
		expect(body.data).toEqual([{ day: "2026-10-01", score: 80 }]);
		expect(body.count).toBe(1);
	});

	it("uses the vO2_max path", async () => {
		const { handlers, list } = setup(async () => []);
		await handlers.get("get_vo2_max")!({ start_date: "2026-10-01", end_date: "2026-10-03" });
		expect(list.mock.calls[0][0]).toBe("vO2_max");
	});

	it("chunks heart rate in 7-day windows with HK offsets and dedupes", async () => {
		const { handlers, list } = setup(async () => [{ bpm: 60, source: "awake", timestamp: "2026-10-01T00:00:00Z" }]);
		const res = await handlers.get("get_heart_rate")!({ start_date: "2026-10-01", end_date: "2026-10-10", granularity: "auto" });
		expect(list.mock.calls.map((c) => c[1])).toEqual([
			{ start_datetime: "2026-10-01T00:00:00+08:00", end_datetime: "2026-10-08T00:00:00+08:00" },
			{ start_datetime: "2026-10-08T00:00:00+08:00", end_datetime: "2026-10-11T00:00:00+08:00" },
		]);
		const body = JSON.parse(res.content[0].text);
		expect(body.granularity).toBe("day");
		expect(body.sample_count).toBe(1);
	});

	it("returns readable errors for bad ranges, rate limits and Oura failures", async () => {
		const { handlers } = setup(async () => {
			throw new OuraApiError(429, "Oura rate limit reached.");
		});
		const tooLong = await handlers.get("get_daily_sleep")!({ start_date: "2026-01-01", end_date: "2026-06-01" });
		expect(tooLong.isError).toBe(true);
		expect(tooLong.content[0].text).toMatch(/maximum is 90/);

		const oura = await handlers.get("get_daily_sleep")!({ start_date: "2026-01-01", end_date: "2026-01-02" });
		expect(oura.isError).toBe(true);
		expect(oura.content[0].text).toBe("Oura rate limit reached.");

		const limited = setup(async () => [], false);
		const rl = await limited.handlers.get("get_daily_sleep")!({});
		expect(rl.isError).toBe(true);
		expect(rl.content[0].text).toBe("slow down");
	});

	it("hides unexpected internal errors", async () => {
		const { handlers } = setup(async () => {
			throw new Error("secret internals");
		});
		const res = await handlers.get("get_workouts")!({});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).not.toContain("secret");
	});
});
