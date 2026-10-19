import { localDayKey, localHourKey } from "../dates";

type Doc = Record<string, unknown>;

/** Copy only the listed keys that are present and non-null. */
function pick(doc: Doc, keys: readonly string[]): Doc {
	const out: Doc = {};
	for (const k of keys) {
		const v = doc[k];
		if (v !== undefined && v !== null) out[k] = v;
	}
	return out;
}

function obj(value: unknown): Doc | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : undefined;
}

/** Seconds → minutes, rounded. Oura reports durations in seconds. */
function minutes(value: unknown): number | undefined {
	return typeof value === "number" ? Math.round(value / 60) : undefined;
}

function withMinutes(doc: Doc, keys: readonly string[]): Doc {
	const out: Doc = {};
	for (const k of keys) {
		const m = minutes(doc[k]);
		if (m !== undefined) out[`${k.replace(/_duration$|_time$/, "")}_min`] = m;
	}
	return out;
}

function round(value: unknown, digits = 1): number | undefined {
	if (typeof value !== "number") return undefined;
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

export function compactDailyReadiness(d: Doc): Doc {
	return {
		...pick(d, ["day", "score", "temperature_deviation", "temperature_trend_deviation"]),
		...(obj(d.contributors) ? { contributors: obj(d.contributors) } : {}),
	};
}

export function compactDailySleep(d: Doc): Doc {
	return {
		...pick(d, ["day", "score"]),
		...(obj(d.contributors) ? { contributors: obj(d.contributors) } : {}),
	};
}

export function compactSleepSession(d: Doc): Doc {
	const readiness = obj(d.readiness);
	return {
		...pick(d, ["day", "type", "bedtime_start", "bedtime_end", "efficiency", "restless_periods"]),
		...withMinutes(d, [
			"total_sleep_duration",
			"time_in_bed",
			"deep_sleep_duration",
			"rem_sleep_duration",
			"light_sleep_duration",
			"awake_time",
			"latency",
		]),
		...pick(d, ["average_hrv", "average_heart_rate", "lowest_heart_rate"]),
		...(round(d.average_breath) !== undefined ? { average_breath: round(d.average_breath) } : {}),
		...(readiness?.score !== undefined && readiness.score !== null ? { readiness_score: readiness.score } : {}),
	};
}

export function compactDailyActivity(d: Doc): Doc {
	return {
		...pick(d, [
			"day",
			"score",
			"steps",
			"active_calories",
			"total_calories",
			"target_calories",
			"equivalent_walking_distance",
			"inactivity_alerts",
		]),
		...withMinutes(d, [
			"high_activity_time",
			"medium_activity_time",
			"low_activity_time",
			"sedentary_time",
			"resting_time",
			"non_wear_time",
		]),
		...(obj(d.contributors) ? { contributors: obj(d.contributors) } : {}),
	};
}

export function compactWorkout(d: Doc): Doc {
	return {
		...pick(d, ["day", "activity", "label", "intensity", "start_datetime", "end_datetime", "source"]),
		...(round(d.calories, 0) !== undefined ? { calories: round(d.calories, 0) } : {}),
		...(round(d.distance, 0) !== undefined ? { distance_m: round(d.distance, 0) } : {}),
	};
}

export function compactDailyStress(d: Doc): Doc {
	return {
		...pick(d, ["day", "day_summary"]),
		...(minutes(d.stress_high) !== undefined ? { stress_high_min: minutes(d.stress_high) } : {}),
		...(minutes(d.recovery_high) !== undefined ? { recovery_high_min: minutes(d.recovery_high) } : {}),
	};
}

export function compactDailyResilience(d: Doc): Doc {
	return {
		...pick(d, ["day", "level"]),
		...(obj(d.contributors) ? { contributors: obj(d.contributors) } : {}),
	};
}

export function compactDailySpo2(d: Doc): Doc {
	const spo2 = obj(d.spo2_percentage);
	return {
		...pick(d, ["day", "breathing_disturbance_index"]),
		...(spo2?.average !== undefined && spo2.average !== null ? { spo2_average: round(spo2.average) } : {}),
	};
}

export function compactVo2Max(d: Doc): Doc {
	return pick(d, ["day", "vo2_max"]);
}

export function compactCardiovascularAge(d: Doc): Doc {
	return pick(d, ["day", "vascular_age"]);
}

export type HeartRateGranularity = "hour" | "day";

export interface HeartRateBucket {
	period: string;
	source: string;
	min: number;
	avg: number;
	max: number;
	samples: number;
}

/** Aggregate raw heart-rate samples into min/avg/max per local hour (or day) per source. */
export function aggregateHeartRate(
	samples: Doc[],
	granularity: HeartRateGranularity,
	timeZone: string,
): HeartRateBucket[] {
	const buckets = new Map<string, { period: string; source: string; min: number; max: number; sum: number; n: number }>();
	for (const s of samples) {
		const bpm = s.bpm;
		const ts = s.timestamp;
		if (typeof bpm !== "number" || typeof ts !== "string" || Number.isNaN(Date.parse(ts))) continue;
		const period = granularity === "hour" ? localHourKey(ts, timeZone) : localDayKey(ts, timeZone);
		const source = typeof s.source === "string" ? s.source : "unknown";
		const key = `${period}|${source}`;
		const b = buckets.get(key);
		if (b) {
			b.min = Math.min(b.min, bpm);
			b.max = Math.max(b.max, bpm);
			b.sum += bpm;
			b.n += 1;
		} else {
			buckets.set(key, { period, source, min: bpm, max: bpm, sum: bpm, n: 1 });
		}
	}
	return [...buckets.values()]
		.sort((a, b) => (a.period === b.period ? a.source.localeCompare(b.source) : a.period.localeCompare(b.period)))
		.map((b) => ({ period: b.period, source: b.source, min: b.min, avg: Math.round(b.sum / b.n), max: b.max, samples: b.n }));
}

/** Keep documents whose `day` falls inside [start, end]. Documents without `day` are kept. */
export function filterByDay(docs: Doc[], start: string, end: string): Doc[] {
	return docs.filter((d) => typeof d.day !== "string" || (d.day >= start && d.day <= end));
}
