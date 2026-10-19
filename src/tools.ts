import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_RANGE_DAYS } from "./config";
import { addDays, DateRangeError, type DateRange, resolveDateRange, startOfDayIso } from "./dates";
import { OuraApiError, type OuraClient } from "./oura/client";
import {
	aggregateHeartRate,
	compactCardiovascularAge,
	compactDailyActivity,
	compactDailyReadiness,
	compactDailyResilience,
	compactDailySleep,
	compactDailySpo2,
	compactDailyStress,
	compactSleepSession,
	compactVo2Max,
	compactWorkout,
	filterByDay,
	type HeartRateGranularity,
} from "./oura/transform";

type Doc = Record<string, unknown>;

export class RateLimitedError extends Error {}

export interface ToolDeps {
	/** IANA timezone used to interpret dates (e.g. "Asia/Hong_Kong"). */
	timeZone: string;
	/** Returns a client for the authenticated user; throws if not authorized. */
	getClient(): OuraClient;
	/** Throws RateLimitedError when the caller is over its limit. */
	checkRateLimit(): Promise<void>;
}

const dateParam = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.optional();

function rangeShape(timeZone: string) {
	return {
		start_date: dateParam.describe(
			`First day to include (YYYY-MM-DD, ${timeZone}). Defaults to 6 days before end_date (a 7-day window).`,
		),
		end_date: dateParam.describe(`Last day to include (YYYY-MM-DD, ${timeZone}). Defaults to today.`),
	};
}

function rangeNote(timeZone: string): string {
	return `Dates are calendar days in ${timeZone}, inclusive. Defaults to the last 7 days; max ${MAX_RANGE_DAYS} days per call.`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(range: DateRange, timeZone: string, data: unknown, extra: Record<string, unknown> = {}) {
	const body = { start_date: range.start, end_date: range.end, timezone: timeZone, ...extra, data };
	return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function fail(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Run a tool body with uniform validation, rate limiting and error mapping. Never echoes tokens or raw payloads. */
async function run(deps: ToolDeps, fn: () => Promise<ReturnType<typeof ok>>) {
	try {
		await deps.checkRateLimit();
		return await fn();
	} catch (err) {
		if (err instanceof DateRangeError || err instanceof RateLimitedError || err instanceof OuraApiError) {
			return fail(err.message);
		}
		console.error(`tool error: ${err instanceof Error ? err.name : "unknown"}`);
		return fail("Unexpected server error while fetching Oura data.");
	}
}

/**
 * List a daily-keyed collection. Oura's end_date handling differs between
 * collections, so query one extra day and filter on `day` locally.
 */
async function listDaily(client: OuraClient, collection: string, range: DateRange): Promise<Doc[]> {
	const docs = await client.list(collection, { start_date: range.start, end_date: addDays(range.end, 1) });
	return filterByDay(docs, range.start, range.end);
}

interface DailyToolSpec {
	name: string;
	title: string;
	description: string;
	collection: string;
	compact: (d: Doc) => Doc;
}

const DAILY_TOOLS: DailyToolSpec[] = [
	{
		name: "get_daily_readiness",
		title: "Daily readiness",
		description:
			"Oura daily Readiness score (0-100) per day with its contributors (HRV balance, resting heart rate, body temperature, recovery index, sleep balance, previous night, activity balance) and body temperature deviation (°C). Use for questions about recovery, readiness to train, or how 'ready' the body is.",
		collection: "daily_readiness",
		compact: compactDailyReadiness,
	},
	{
		name: "get_daily_sleep",
		title: "Daily sleep score",
		description:
			"Oura daily Sleep score (0-100) per day with contributor scores (total sleep, efficiency, restfulness, REM, deep sleep, latency, timing). Use for a quick per-night sleep quality overview. For durations, stages, HRV or heart rate during sleep, use get_sleep_sessions.",
		collection: "daily_sleep",
		compact: compactDailySleep,
	},
	{
		name: "get_sleep_sessions",
		title: "Sleep sessions (detailed)",
		description:
			"Detailed Oura sleep periods: bedtime start/end, type (long_sleep = main sleep, sleep, late_nap, rest), total sleep / time in bed / deep / REM / light / awake minutes, latency, efficiency, average HRV (ms), average and lowest heart rate (bpm), average breathing rate. A day can have several periods (naps). Use for sleep stages, HRV, resting heart rate overnight, or bed/wake times.",
		collection: "sleep",
		compact: compactSleepSession,
	},
	{
		name: "get_daily_activity",
		title: "Daily activity",
		description:
			"Oura daily Activity per day: activity score, steps, active and total calories, target calories, walking-equivalent distance (m), minutes of high/medium/low activity, sedentary, resting and non-wear time, inactivity alerts, and score contributors. Use for steps, calories, movement and activity goals.",
		collection: "daily_activity",
		compact: compactDailyActivity,
	},
	{
		name: "get_workouts",
		title: "Workouts",
		description:
			"Workouts recorded or detected by Oura: activity type, start/end time, intensity, calories, distance (m), and source (manual, autodetected, confirmed, or a connected app). Use for exercise history and training load questions.",
		collection: "workout",
		compact: compactWorkout,
	},
	{
		name: "get_daily_stress",
		title: "Daily stress",
		description:
			"Oura daily Stress per day: minutes spent in high stress and in high recovery during the day, and the day summary (restored, normal, or stressful). Use for daytime stress and recovery balance.",
		collection: "daily_stress",
		compact: compactDailyStress,
	},
	{
		name: "get_daily_resilience",
		title: "Daily resilience",
		description:
			"Oura daily Resilience level (limited, adequate, solid, strong, exceptional) with contributors (sleep recovery, daytime recovery, stress). Use for longer-term capacity to handle stress.",
		collection: "daily_resilience",
		compact: compactDailyResilience,
	},
	{
		name: "get_daily_spo2",
		title: "Daily SpO2",
		description:
			"Oura nightly blood oxygen: average SpO2 percentage during sleep and the breathing disturbance index. Use for blood oxygen or breathing-during-sleep questions.",
		collection: "daily_spo2",
		compact: compactDailySpo2,
	},
	{
		name: "get_vo2_max",
		title: "VO2 max",
		description:
			"Oura VO2 max estimates (ml/kg/min) per day they were measured (Oura estimates it from walking tests, so values are sparse). Use for cardiorespiratory fitness.",
		collection: "vO2_max",
		compact: compactVo2Max,
	},
	{
		name: "get_cardiovascular_age",
		title: "Cardiovascular age",
		description:
			"Oura Cardiovascular Age per day: estimated vascular age in years, derived from pulse wave velocity. Use for arterial stiffness / heart health trend questions.",
		collection: "daily_cardiovascular_age",
		compact: compactCardiovascularAge,
	},
];

export function registerTools(server: McpServer, deps: ToolDeps): void {
	const tz = deps.timeZone;
	for (const spec of DAILY_TOOLS) {
		server.registerTool(
			spec.name,
			{
				title: spec.title,
				description: `${spec.description} ${rangeNote(tz)}`,
				inputSchema: z.object(rangeShape(tz)),
				annotations: { title: spec.title, ...READ_ONLY },
			},
			async ({ start_date, end_date }) =>
				run(deps, async () => {
					const range = resolveDateRange(start_date, end_date, tz);
					const docs = await listDaily(deps.getClient(), spec.collection, range);
					return ok(range, tz, docs.map(spec.compact), { count: docs.length });
				}),
		);
	}

	server.registerTool(
		"get_heart_rate",
		{
			title: "Heart rate",
			description: `Oura heart rate samples aggregated into min/avg/max bpm per local hour or day, split by source (awake, rest, sleep, session, live, workout). Use for daytime heart rate patterns, resting heart rate trends, or heart rate around a specific time. For overnight HRV and lowest heart rate, prefer get_sleep_sessions. granularity "auto" uses hourly buckets for ranges up to 7 days and daily buckets otherwise. ${rangeNote(tz)}`,
			inputSchema: z.object({
				...rangeShape(tz),
				granularity: z
					.enum(["auto", "hour", "day"])
					.default("auto")
					.describe('Bucket size: "hour", "day", or "auto" (hour for ≤7 days, else day).'),
			}),
			annotations: { title: "Heart rate", ...READ_ONLY },
		},
		async ({ start_date, end_date, granularity }) =>
			run(deps, async () => {
				const range = resolveDateRange(start_date, end_date, tz);
				const g: HeartRateGranularity =
					granularity === "hour" || granularity === "day" ? granularity : range.days <= 7 ? "hour" : "day";
				const client = deps.getClient();
				// Query in 7-day windows to keep each Oura request small.
				const samples: Doc[] = [];
				for (let chunkStart = range.start; chunkStart <= range.end; chunkStart = addDays(chunkStart, 7)) {
					const chunkEndExclusive = addDays(chunkStart, 7) > addDays(range.end, 1) ? addDays(range.end, 1) : addDays(chunkStart, 7);
					samples.push(
						...(await client.list("heartrate", {
							start_datetime: startOfDayIso(chunkStart, tz),
							end_datetime: startOfDayIso(chunkEndExclusive, tz),
						})),
					);
				}
				// Chunk boundaries may be inclusive on Oura's side; drop duplicate samples.
				const seen = new Set<string>();
				const unique = samples.filter((s) => {
					const key = `${s.timestamp}|${s.source}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				});
				const buckets = aggregateHeartRate(unique, g, tz);
				return ok(range, tz, buckets, { granularity: g, sample_count: unique.length, bucket_count: buckets.length });
			}),
	);
}

export const TOOL_NAMES = [...DAILY_TOOLS.map((t) => t.name), "get_heart_rate"];
