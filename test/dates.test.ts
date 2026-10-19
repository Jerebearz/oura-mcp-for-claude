import { describe, expect, it } from "vitest";
import {
	addDays,
	DateRangeError,
	localDayKey,
	localHourKey,
	offsetMinutes,
	resolveDateRange,
	resolveTimezone,
	startOfDayIso,
	todayInTimezone,
} from "../src/dates";

const HK = "Asia/Hong_Kong";
const NY = "America/New_York";
// 2026-10-12 17:30 UTC = 2026-10-13 01:30 in Hong Kong = 2026-10-12 13:30 in New York
const NOW = new Date("2026-10-12T17:30:00Z");

describe("dates", () => {
	it("computes today in the configured timezone", () => {
		expect(todayInTimezone(HK, NOW)).toBe("2026-10-13");
		expect(todayInTimezone(NY, NOW)).toBe("2026-10-12");
		expect(todayInTimezone("UTC", NOW)).toBe("2026-10-12");
	});

	it("defaults to the last 7 days ending today", () => {
		expect(resolveDateRange(undefined, undefined, HK, NOW)).toEqual({ start: "2026-10-07", end: "2026-10-13", days: 7 });
		expect(resolveDateRange(undefined, undefined, NY, NOW)).toEqual({ start: "2026-10-06", end: "2026-10-12", days: 7 });
	});

	it("defaults start to 6 days before end", () => {
		expect(resolveDateRange(undefined, "2026-01-10", HK, NOW)).toEqual({ start: "2026-01-04", end: "2026-01-10", days: 7 });
	});

	it("defaults end to start+6, capped at today", () => {
		expect(resolveDateRange("2026-01-01", undefined, HK, NOW).end).toBe("2026-01-07");
		expect(resolveDateRange("2026-10-11", undefined, HK, NOW).end).toBe("2026-10-13");
	});

	it("allows exactly 90 days and rejects 91", () => {
		expect(resolveDateRange("2026-01-01", "2026-03-31", HK, NOW).days).toBe(90);
		expect(() => resolveDateRange("2026-01-01", "2026-04-01", HK, NOW)).toThrow(DateRangeError);
	});

	it("rejects bad formats, invalid dates and reversed ranges", () => {
		expect(() => resolveDateRange("2026/01/01", "2026-01-02", HK, NOW)).toThrow(DateRangeError);
		expect(() => resolveDateRange("2026-02-30", "2026-03-01", HK, NOW)).toThrow(DateRangeError);
		expect(() => resolveDateRange("2026-01-05", "2026-01-01", HK, NOW)).toThrow(/after/);
	});

	it("handles month/year boundaries", () => {
		expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("buckets timestamps in local time", () => {
		expect(localHourKey("2026-10-12T17:05:00+00:00", HK)).toBe("2026-10-13T01:00");
		expect(localDayKey("2026-10-12T15:59:59Z", HK)).toBe("2026-10-12");
		expect(localDayKey("2026-10-12T16:00:00Z", HK)).toBe("2026-10-13");
		expect(localHourKey("2026-10-12T17:05:00Z", NY)).toBe("2026-10-12T13:00");
	});

	it("builds local-midnight datetimes with the right offset, including DST", () => {
		expect(startOfDayIso("2026-10-12", HK)).toBe("2026-10-12T00:00:00+08:00");
		expect(startOfDayIso("2026-10-12", "UTC")).toBe("2026-10-12T00:00:00+00:00");
		// New York: EST (-05:00) in winter, EDT (-04:00) in summer; DST starts 2026-03-08, ends 2026-11-01.
		expect(startOfDayIso("2026-01-15", NY)).toBe("2026-01-15T00:00:00-05:00");
		expect(startOfDayIso("2026-07-15", NY)).toBe("2026-07-15T00:00:00-04:00");
		expect(startOfDayIso("2026-03-08", NY)).toBe("2026-03-08T00:00:00-05:00");
		expect(startOfDayIso("2026-03-09", NY)).toBe("2026-03-09T00:00:00-04:00");
		expect(startOfDayIso("2026-11-01", NY)).toBe("2026-11-01T00:00:00-04:00");
		expect(startOfDayIso("2026-11-02", NY)).toBe("2026-11-02T00:00:00-05:00");
		// Half-hour offset
		expect(startOfDayIso("2026-10-12", "Asia/Kolkata")).toBe("2026-10-12T00:00:00+05:30");
	});

	it("computes offsets", () => {
		expect(offsetMinutes(Date.parse("2026-10-12T00:00:00Z"), HK)).toBe(480);
		expect(offsetMinutes(Date.parse("2026-01-12T00:00:00Z"), NY)).toBe(-300);
	});

	it("validates the configured timezone and falls back to UTC", () => {
		expect(resolveTimezone("Asia/Hong_Kong")).toBe("Asia/Hong_Kong");
		expect(resolveTimezone(" Europe/London ")).toBe("Europe/London");
		expect(resolveTimezone(undefined)).toBe("UTC");
		expect(resolveTimezone("")).toBe("UTC");
		expect(resolveTimezone("Not/AZone")).toBe("UTC");
	});
});
