import { describe, expect, it } from "vitest";
import { publicBaseUrl } from "../src/base-url";

describe("publicBaseUrl", () => {
	const req = new Request("https://personal-oura-mcp.someone.workers.dev/authorize?x=1");
	it("defaults to the request origin", () => {
		expect(publicBaseUrl({}, req)).toBe("https://personal-oura-mcp.someone.workers.dev");
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "  " }, req)).toBe("https://personal-oura-mcp.someone.workers.dev");
	});
	it("uses PUBLIC_BASE_URL when set, without trailing slashes", () => {
		expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://oura.example.com/" }, req)).toBe("https://oura.example.com");
	});
});
