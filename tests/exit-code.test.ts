import { describe, expect, it } from "vitest";
import { exitCodeFor } from "../src/exit-code.js";
import { ApiError, NetworkError } from "../src/http.js";

describe("exitCodeFor", () => {
  it("maps 401/403 to 4 (auth)", () => {
    expect(exitCodeFor(new ApiError(401, "unauthorized"))).toBe(4);
    expect(exitCodeFor(new ApiError(403, "forbidden"))).toBe(4);
  });

  it("maps 404 to 5 (not found)", () => {
    expect(exitCodeFor(new ApiError(404, "not found"))).toBe(5);
  });

  it("maps 4xx validation errors to 2 (usage/validation)", () => {
    expect(exitCodeFor(new ApiError(400, "bad request"))).toBe(2);
    expect(exitCodeFor(new ApiError(409, "conflict"))).toBe(2);
  });

  it("maps 5xx server errors to 6, not 2 -- an upstream failure isn't a usage error (ahood-cli#31)", () => {
    expect(exitCodeFor(new ApiError(500, "internal error"))).toBe(6);
    expect(exitCodeFor(new ApiError(502, "bad gateway"))).toBe(6);
    expect(exitCodeFor(new ApiError(503, "unavailable"))).toBe(6);
  });

  it("maps NetworkError to 6", () => {
    expect(exitCodeFor(new NetworkError("fetch failed"))).toBe(6);
  });

  it("maps anything else to 1 (general error)", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
    expect(exitCodeFor("not even an error")).toBe(1);
  });
});
