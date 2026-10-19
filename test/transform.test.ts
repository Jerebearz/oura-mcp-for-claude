import { describe, expect, it } from "vitest";
import {
	aggregateHeartRate,
	compactDailySpo2,
	compactDailyStress,
	compactSleepSession,
	compactWorkout,
	filterByDay,
} from "../src/oura/transform";

describe("transforms", () => {
	it("compacts a sleep session and drops bulky series", () => {
		const out = compactSleepSession({
			id: "x",
			day: "2026-10-10",
			type: "long_sleep",
			bedtime_start: "2026-10-09T23:10:00+08:00",
			bedtime_end: "2026-10-10T07:00:00+08:00",
			total_sleep_duration: 25200,
			deep_sleep_duration: 5400,
			rem_sleep_duration: 6000,
			light_sleep_duration: 13800,
			awake_time: 2700,
			time_in_bed: 28200,
			latency: 600,
			efficiency: 89,
			average_hrv: 52,
			average_heart_rate: 55.25,
			lowest_heart_rate: 48,
			average_breath: 14.625,
			readiness: { score: 81, contributors: {} },
			heart_rate: { items: new Array(100).fill(55) },
			hrv: { items: new Array(100).fill(50) },
			sleep_phase_5_min: "4433221",
		});
		expect(out).toEqual({
			day: "2026-10-10",
			type: "long_sleep",
			bedtime_start: "2026-10-09T23:10:00+08:00",
			bedtime_end: "2026-10-10T07:00:00+08:00",
			efficiency: 89,
			total_sleep_min: 420,
			time_in_bed_min: 470,
			deep_sleep_min: 90,
			rem_sleep_min: 100,
			light_sleep_min: 230,
			awake_min: 45,
			latency_min: 10,
			average_hrv: 52,
			average_heart_rate: 55.25,
			lowest_heart_rate: 48,
			average_breath: 14.6,
			readiness_score: 81,
		});
	});

	it("converts stress seconds to minutes and keeps nulls out", () => {
		expect(compactDailyStress({ day: "2026-10-10", stress_high: 3600, recovery_high: 1800, day_summary: null })).toEqual({
			day: "2026-10-10",
			stress_high_min: 60,
			recovery_high_min: 30,
		});
	});

	it("flattens SpO2", () => {
		expect(compactDailySpo2({ day: "d", spo2_percentage: { average: 96.444 }, breathing_disturbance_index: 3 })).toEqual({
			day: "d",
			breathing_disturbance_index: 3,
			spo2_average: 96.4,
		});
	});

	it("rounds workout calories and distance", () => {
		expect(compactWorkout({ day: "d", activity: "running", calories: 412.7, distance: 5012.4, intensity: "hard" })).toEqual({
			day: "d",
			activity: "running",
			intensity: "hard",
			calories: 413,
			distance_m: 5012,
		});
	});

	it("aggregates heart rate per HK hour and source", () => {
		const buckets = aggregateHeartRate(
			[
				{ bpm: 60, source: "awake", timestamp: "2026-10-12T01:00:00+00:00" },
				{ bpm: 70, source: "awake", timestamp: "2026-10-12T01:30:00+00:00" },
				{ bpm: 50, source: "rest", timestamp: "2026-10-12T01:10:00+00:00" },
				{ bpm: 80, source: "awake", timestamp: "2026-10-12T02:00:00+00:00" },
				{ bpm: "bad", source: "awake", timestamp: "2026-10-12T02:00:00+00:00" },
			],
			"hour",
			"Asia/Hong_Kong",
		);
		expect(buckets).toEqual([
			{ period: "2026-10-12T09:00", source: "awake", min: 60, avg: 65, max: 70, samples: 2 },
			{ period: "2026-10-12T09:00", source: "rest", min: 50, avg: 50, max: 50, samples: 1 },
			{ period: "2026-10-12T10:00", source: "awake", min: 80, avg: 80, max: 80, samples: 1 },
		]);
		expect(aggregateHeartRate([{ bpm: 60, source: "awake", timestamp: "2026-10-12T01:00:00Z" }], "day", "Asia/Hong_Kong")[0].period).toBe(
			"2026-10-12",
		);
	});

	it("filters documents to the requested days", () => {
		const docs = [{ day: "2026-10-01" }, { day: "2026-10-05" }, { day: "2026-10-08" }];
		expect(filterByDay(docs, "2026-10-02", "2026-10-07")).toEqual([{ day: "2026-10-05" }]);
	});
});
