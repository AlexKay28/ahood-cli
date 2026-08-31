import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { apiJson, ApiError } from "../src/http.js";

const API_URL = "http://ahood.test";

describe("apiJson error sanitization", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("passes short, normal server error messages through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "This token's scopes do not include 'publish'" }), { status: 403 })),
    );
    await expect(apiJson("/x")).rejects.toThrow("This token's scopes do not include 'publish'");
  });

  it("replaces an HTML-shaped error body (e.g. a WAF/proxy block page) with a short, safe summary (ahood-cli#31)", async () => {
    const html = "<!DOCTYPE html>\n<html><head><title>Attention Required! | Cloudflare</title></head><body>Ray ID: abc123, Your IP: 1.2.3.4</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: html }), { status: 500 })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const message = (caught as ApiError).message;
    expect(message).not.toContain("<html");
    expect(message).not.toContain("Cloudflare");
    expect(message).not.toContain("Ray ID");
    expect(message.length).toBeLessThan(300);
  });

  it("replaces an implausibly long error message even without HTML markers", async () => {
    const huge = "x".repeat(2000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: huge }), { status: 500 })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError).message.length).toBeLessThan(300);
  });
});
