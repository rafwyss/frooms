// Client for ETH's room-info API: retry, timeout, concurrency limit and a two-level cache.
// Port of app/eth_client.py. Values are cached as parsed JSON in isolate memory and, where the
// runtime offers it (custom domains, not *.workers.dev), in the colo-wide Cache API.

import {
  ALLOCATIONS_TTL_S,
  BASE_URL,
  ETH_BACKOFF_MIN_S,
  HTTP_TIMEOUT_MS,
  MAX_CONCURRENT_REQUESTS,
  MIN_MAX_TTL_S,
  ON_DEMAND_PER_MINUTE,
} from "./config";
import { addDays, type IsoDate } from "./tz";

interface Cached {
  at: number; // epoch ms when fetched from ETH
  value: unknown;
}

const memory = new Map<string, Cached>();
const CACHE_ORIGIN = "https://cache.frooms.internal";

// ETH rate-limits its API (HTTP 503 with Retry-After). Once it does, this isolate stops asking until the backoff ends.
let backoffUntil = 0;
// Sliding window of on-demand request times in this isolate.
let onDemand: number[] = [];

/** Forget everything cached in this isolate (for tests). */
export const clearMemoryCache = () => {
  memory.clear();
  backoffUntil = 0;
  onDemand = [];
};

export class EthError extends Error {}

/** ETH asked us to slow down (or we are still waiting after it did). */
export class RateLimited extends EthError {
  constructor(readonly until: number) {
    super(`ETH rate limit, backing off until ${new Date(until).toISOString()}`);
  }
}

/** This isolate has used up its on-demand budget for the current minute. */
export class BudgetExhausted extends EthError {
  constructor() {
    super("on-demand budget exhausted");
  }
}

export const ethBackoffUntil = () => backoffUntil;

export function noteBackoff(until: number) {
  backoffUntil = Math.max(backoffUntil, until);
}

function takeOnDemandToken(now = Date.now()): boolean {
  onDemand = onDemand.filter((t) => now - t < 60_000);
  if (onDemand.length >= ON_DEMAND_PER_MINUTE) return false;
  onDemand.push(now);
  return true;
}

/** Turn a 429/503 into a RateLimited error with a backoff of at least ETH_BACKOFF_MIN_S. */
function rateLimitFrom(resp: Response): RateLimited {
  const retryAfter = Number(resp.headers.get("retry-after"));
  const waitS = Math.max(ETH_BACKOFF_MIN_S, Number.isFinite(retryAfter) ? retryAfter : 0);
  const until = Date.now() + waitS * 1000;
  noteBackoff(until);
  return new RateLimited(until);
}

/** Run `fn` over `items` with at most `limit` in flight; results keep their order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class EthClient {
  /**
   * `onDemand`: requests made on behalf of a visitor count against the per-isolate budget.
   * The scheduled prefetch passes false and paces itself.
   */
  constructor(
    private readonly userAgent: string,
    private readonly ctx?: { waitUntil(p: Promise<unknown>): void },
    private readonly onDemand = true,
  ) {}

  /** A room-info request, e.g. get("/rooms/ML E 13/allocations", { from, to }). */
  get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    // Build the query by hand so spaces in room paths become %20, as ETH's own pages send them.
    const query = [`path=${encodeURIComponent(path).replaceAll("%2F", "/")}`]
      .concat(Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`))
      .join("&");
    return this.getUrl(`${BASE_URL}?${query}`);
  }

  /** Any ETH JSON endpoint, with the same retry, timeout and backoff as the room info. */
  async getUrl(url: string): Promise<unknown> {
    if (Date.now() < backoffUntil) throw new RateLimited(backoffUntil);
    if (this.onDemand && !takeOnDemandToken()) throw new BudgetExhausted();
    for (let attempt = 0; ; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (resp.status === 429 || resp.status === 503) throw rateLimitFrom(resp);
        if (!resp.ok) throw new EthError(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) {
        // Never retry into a rate limit; it only makes the block longer.
        if (attempt === 1 || e instanceof RateLimited) throw e;
        console.warn(`ETH request failed (${e}), retrying: ${url}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async cached(key: string, ttlS: number, fetcher: () => Promise<unknown>): Promise<Cached> {
    const now = Date.now();
    const hit = memory.get(key);
    if (hit && now - hit.at < ttlS * 1000) return hit;

    const cacheKey = new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`);
    const cache = typeof caches !== "undefined" ? caches.default : undefined;
    const shared = await cache?.match(cacheKey);
    if (shared) {
      const entry: Cached = await shared.json();
      if (now - entry.at < ttlS * 1000) {
        memory.set(key, entry);
        return entry;
      }
    }

    const entry: Cached = { at: Date.now(), value: await fetcher() };
    memory.set(key, entry);
    if (cache) {
      const put = cache.put(
        cacheKey,
        new Response(JSON.stringify(entry), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlS}` },
        }),
      );
      this.ctx ? this.ctx.waitUntil(put) : await put;
    }
    return entry;
  }

  async minMaxDates(): Promise<[IsoDate, IsoDate]> {
    const { value } = await this.cached("minmax", MIN_MAX_TTL_S, () => this.get("/min-max-allocation-date"));
    const data = value as { minDateLoad: string; maxDateLoad: string };
    return [data.minDateLoad.slice(0, 10), data.maxDateLoad.slice(0, 10)];
  }

  /** Allocations for `day` and the following day (so late-evening queries still see the next morning). */
  async allocations(roomPath: string, day: IsoDate): Promise<Cached> {
    const end = addDays(day, 1);
    return this.cached(`alloc/${roomPath}/${day}`, ALLOCATIONS_TTL_S, () =>
      this.get(`/rooms/${roomPath}/allocations`, { from: day, to: end }),
    );
  }

  static concurrency = MAX_CONCURRENT_REQUESTS;
}
