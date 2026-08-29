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
});
