import { DEFAULT_RANGE_DAYS, DEFAULT_TIMEZONE, MAX_RANGE_DAYS } from "./config";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export interface DateRange {
	start: string; // YYYY-MM-DD, inclusive
	end: string; // YYYY-MM-DD, inclusive
	days: number;
}

export class DateRangeError extends Error {}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached formatter giving local wall-clock parts (24h) in `timeZone`. */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, f);
	}
	return f;
}

interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function wallClock(instantMs: number, timeZone: string): WallClock {
	const out: Record<string, number> = {};
	for (const p of partsFormatter(timeZone).formatToParts(new Date(instantMs))) {
		if (p.type !== "literal") out[p.type] = Number(p.value);
	}
	return {
		year: out.year,
		month: out.month,
		day: out.day,
		hour: out.hour === 24 ? 0 : out.hour,
		minute: out.minute,
		second: out.second,
	};
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Return `value` if it is a valid IANA timezone, else the default (UTC). */
export function resolveTimezone(value: string | undefined): string {
	const tz = (value ?? "").trim();
	if (!tz) return DEFAULT_TIMEZONE;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch {
		console.error("TIMEZONE is not a valid IANA timezone; falling back to UTC");
		return DEFAULT_TIMEZONE;
	}
}

/** Offset of `timeZone` from UTC at `instantMs`, in minutes (e.g. +480 for Asia/Hong_Kong). */
export function offsetMinutes(instantMs: number, timeZone: string): number {
	const w = wallClock(instantMs, timeZone);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

function formatOffset(minutes: number): string {
	const sign = minutes >= 0 ? "+" : "-";
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Today's calendar date in `timeZone`. */
export function todayInTimezone(timeZone: string, now: Date = new Date()): string {
	const w = wallClock(now.getTime(), timeZone);
	return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

function parseDate(value: string, name: string): number {
	if (!DATE_RE.test(value)) {
		throw new DateRangeError(`${name} must be in YYYY-MM-DD format, got "${value}".`);
	}
	const ms = Date.parse(`${value}T00:00:00Z`);
	if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
		throw new DateRangeError(`${name} is not a valid calendar date: "${value}".`);
	}
	return ms;
}

export function addDays(date: string, days: number): string {
	return new Date(parseDate(date, "date") + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolve an inclusive date range. Defaults to the last 7 days ending today in
 * `timeZone`. Rejects ranges longer than 90 days or with start after end.
 */
export function resolveDateRange(
	startDate: string | undefined,
	endDate: string | undefined,
	timeZone: string,
	now: Date = new Date(),
): DateRange {
	const today = todayInTimezone(timeZone, now);
	let end = endDate;
	let start = startDate;
	if (!end) {
		end = start ? addDays(start, DEFAULT_RANGE_DAYS - 1) : today;
		// Don't default past today.
		if (end > today) end = today;
	}
	if (!start) start = addDays(end, -(DEFAULT_RANGE_DAYS - 1));

	const startMs = parseDate(start, "start_date");
	const endMs = parseDate(end, "end_date");
	if (startMs > endMs) {
		throw new DateRangeError(`start_date (${start}) is after end_date (${end}).`);
	}
	const days = Math.round((endMs - startMs) / DAY_MS) + 1;
	if (days > MAX_RANGE_DAYS) {
		throw new DateRangeError(
			`Range is ${days} days; the maximum is ${MAX_RANGE_DAYS}. Split it into smaller requests.`,
		);
	}
	return { start, end, days };
}

/** Local midnight of `date` in `timeZone`, as an ISO datetime with offset (DST-aware). */
export function startOfDayIso(date: string, timeZone: string): string {
	const wallMidnightAsUtc = parseDate(date, "date");
	let offset = offsetMinutes(wallMidnightAsUtc, timeZone);
	const corrected = offsetMinutes(wallMidnightAsUtc - offset * 60_000, timeZone);
	if (corrected !== offset) offset = corrected;
	return `${date}T00:00:00${formatOffset(offset)}`;
}

/** Local "YYYY-MM-DDTHH:00" for a timestamp in `timeZone`. */
export function localHourKey(timestamp: string, timeZone: string): string {
	const w = wallClock(Date.parse(timestamp), timeZone);
	return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:00`;
}

/** Local "YYYY-MM-DD" for a timestamp in `timeZone`. */
export function localDayKey(timestamp: string, timeZone: string): string {
	return localHourKey(timestamp, timeZone).slice(0, 10);
}
