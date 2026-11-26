import { describe, expect, it } from "vitest";
import { clientOf, TokenBuckets } from "./rate-limit";

describe("TokenBuckets", () => {
  it("takes a minute's requests at once, then refills at that rate on the clock given", () => {
    let now = 0;
    const buckets = new TokenBuckets(20, () => now);
    expect(buckets.has("a")).toBe(false);
    for (let i = 0; i < 20; i++) expect(buckets.take("a")).toBe(0);
    expect(buckets.has("a")).toBe(true);
    // One request every 3 seconds comes back.
    expect(buckets.wait("a")).toBe(3);
    expect(buckets.take("a")).toBe(3);
    now = 1500;
    expect(buckets.take("a")).toBe(2);
    now = 3000;
    expect(buckets.take("a")).toBe(0);
    expect(buckets.take("a")).toBe(3);
    // Another key has its own, and an hour refills no more than a minute's.
    expect(buckets.take("b")).toBe(0);
    now = 3_600_000;
    for (let i = 0; i < 20; i++) expect(buckets.take("a")).toBe(0);
    expect(buckets.take("a")).toBeGreaterThan(0);
  });

  it("keeps at most 10,000 keys: refilled ones go first, then the oldest", () => {
    let now = 0;
    const buckets = new TokenBuckets(2, () => now);
    for (let i = 0; i < 10_000; i++) buckets.take(`old-${i}`);
    buckets.take("busy");
    buckets.take("busy");
    // A minute later every old bucket is full again, and limits nothing: they make room.
    now = 60_000;
    buckets.take("busy");
    buckets.take("new");
    expect(buckets.has("old-0")).toBe(false);
    expect(buckets.has("busy")).toBe(true);
    expect(buckets.take("busy")).toBe(0);
    expect(buckets.take("busy")).toBeGreaterThan(0);
  });
});

describe("clientOf", () => {
  it("takes the address the host's proxy added, else X-Real-IP, else one shared key", () => {
    const headers = (values: Record<string, string>) => (name: string) => values[name];
    expect(clientOf(headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
    expect(clientOf(headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientOf(headers({ "x-real-ip": " 203.0.113.8 " }))).toBe("203.0.113.8");
    expect(clientOf(headers({}))).toBe("unknown");
  });
});
