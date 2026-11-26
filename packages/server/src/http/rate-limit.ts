/**
 * The rate limit of DevSync's own MCP endpoint (docs/host.md, DevSync's own endpoint): token
 * buckets in the server's memory, one per token seen valid, checked before the token is verified
 * again, so a flood of one agent's requests costs the host's verification nothing. Each server
 * process keeps its own. Requests without a valid token are the host's to limit, by the visitor's
 * address, which only it can tell behind its proxies.
 */

/** A bucket: the requests it still takes, as of `at` (ms). */
interface Bucket {
  tokens: number;
  at: number;
}

/** The most keys a set of buckets keeps: past them, full buckets go, then the oldest. */
const MAX_KEYS = 10_000;

/**
 * Token buckets by key, each holding up to `perMinute` requests and refilling at that rate, on the
 * clock `now` (ms) gives. A key's bucket starts full.
 */
export class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>();

  constructor(
    readonly perMinute: number,
    private readonly now: () => number,
  ) {}

  /** The bucket of `key` refilled to now, or null when it has none (a full one). */
  #current(key: string): Bucket | null {
    const bucket = this.#buckets.get(key);
    if (!bucket) return null;
    const at = this.now();
    const tokens = Math.min(
      this.perMinute,
      bucket.tokens + ((at - bucket.at) * this.perMinute) / 60_000,
    );
    return { tokens, at };
  }

  /** Whether `key` has a bucket: it took a request before, and room wasn't made for others since. */
  has(key: string): boolean {
    return this.#buckets.has(key);
  }

  /** The seconds until `key` may take a request, or 0 when it may now. */
  wait(key: string): number {
    const bucket = this.#current(key);
    if (!bucket || bucket.tokens >= 1) return 0;
    return Math.ceil(((1 - bucket.tokens) * 60) / this.perMinute);
  }

  /** Takes a request for `key`: the seconds to wait when it may not (taking nothing), else 0. */
  take(key: string): number {
    const wait = this.wait(key);
    if (wait > 0) return wait;
    const bucket = this.#current(key) ?? { tokens: this.perMinute, at: this.now() };
    if (!this.#buckets.has(key)) this.#makeRoom();
    this.#buckets.set(key, { tokens: bucket.tokens - 1, at: bucket.at });
    return 0;
  }

  /** Below `MAX_KEYS`: the buckets refilled to full go first (they limit nothing), then the oldest. */
  #makeRoom(): void {
    if (this.#buckets.size < MAX_KEYS) return;
    for (const key of [...this.#buckets.keys()]) {
      if ((this.#current(key)?.tokens ?? 0) >= this.perMinute) this.#buckets.delete(key);
    }
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size < MAX_KEYS) return;
      this.#buckets.delete(key);
    }
  }
}

/** Requests a minute per agent token seen valid. */
export const TOKEN_REQUESTS_PER_MINUTE = 120;
