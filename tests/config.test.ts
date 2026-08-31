import { describe, expect, it, afterEach } from "vitest";
import { getApiUrl } from "../src/config.js";

describe("getApiUrl", () => {
  const original = process.env.AHOOD_API_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = original;
  });

  it("defaults to the production URL when unset", () => {
    delete process.env.AHOOD_API_URL;
    expect(getApiUrl()).toBe("https://ahood.vercel.app");
  });

  it("uses AHOOD_API_URL when set, with no trailing slash", () => {
    process.env.AHOOD_API_URL = "http://localhost:3000/";
    expect(getApiUrl()).toBe("http://localhost:3000");
  });

  it("strips multiple trailing slashes", () => {
    process.env.AHOOD_API_URL = "https://example.com///";
    expect(getApiUrl()).toBe("https://example.com");
  });

  it("rejects a non-https, non-local override", () => {
    process.env.AHOOD_API_URL = "http://evil.example.com";
    expect(() => getApiUrl()).toThrow(/must use https/);
  });

  it("rejects an invalid URL", () => {
    process.env.AHOOD_API_URL = "not a url";
    expect(() => getApiUrl()).toThrow(/not a valid URL/);
  });

  it("allows http for a reserved test TLD", () => {
    process.env.AHOOD_API_URL = "http://ahood.test";
    expect(getApiUrl()).toBe("http://ahood.test");
  });
});
