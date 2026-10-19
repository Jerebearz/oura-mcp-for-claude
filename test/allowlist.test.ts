import { describe, expect, it } from "vitest";
import { isAllowedOuraUser } from "../src/allowlist";

describe("allowlist", () => {
	it("accepts only the exact allowed ID", () => {
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "abc-123" }, "abc-123")).toBe(true);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: " abc-123\n" }, "abc-123")).toBe(true);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "abc-123" }, "abc-1234")).toBe(false);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "abc-123" }, undefined)).toBe(false);
	});

	it("fails closed when the secret is missing or empty", () => {
		expect(isAllowedOuraUser({}, "abc-123")).toBe(false);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "" }, "")).toBe(false);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "  " }, "")).toBe(false);
	});
});

describe("allowlist normalisation", () => {
	it("ignores spaces, line breaks, quotes, dashes, zero-width chars and case", () => {
		const id = "0a1b2c3d4e5f6a7b8-9c8d7e6f5a4b-11aa2";
		for (const configured of [
			id,
			` ${id}\r\n`,
			`"${id}"`,
			"0a1b2c3d4e5f6a7b8-9c8d7e6f5a4b-\n11aa2",
			"0a1b2c3d4e5f6a7b89c8d7e6f5a4b11aa2",
			"0A1B2C3D4E5F6A7B8-9C8D7E6F5A4B-11AA2",
			"0a1b2c3d4e5f6a7b8​-9c8d7e6f5a4b-11aa2",
		]) {
			expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: configured }, id)).toBe(true);
		}
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "0a1b2c3d4e5f6a7b8-9c8d7e6f5a4b-11aa3" }, id)).toBe(false);
		expect(isAllowedOuraUser({ ALLOWED_OURA_USER_ID: "—" }, "")).toBe(false);
	});
});
