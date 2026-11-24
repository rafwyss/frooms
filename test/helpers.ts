import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const readData = (...parts: string[]) => readFileSync(join(import.meta.dirname, "..", "data", ...parts), "utf8");

/** In-memory stand-in for a Workers KV namespace (get/put of JSON and text only). */
export class FakeKV {
  store = new Map<string, string>();
  puts: string[] = [];

  async get(key: string, opts?: string | { type?: string }) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(v) : v;
  }

  async put(key: string, value: string) {
    this.puts.push(key);
    this.store.set(key, value);
  }

  json(key: string) {
    return JSON.parse(this.store.get(key)!);
  }

  asKV() {
    return this as unknown as KVNamespace;
  }
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params);
  }

  exec() {
    const st = this.db.prepare(this.sql);
    const params = this.params as (string | number | null)[];
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { results: st.all(...params).map((r) => ({ ...r })), success: true };
    const { changes, lastInsertRowid } = st.run(...params);
    return { results: [], success: true, meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
  }

  async all() {
    return this.exec();
  }

  async run() {
    return this.exec();
  }

  async first() {
    return this.exec().results[0] ?? null;
  }
}

/** In-memory stand-in for a D1 database: SQLite with the real migrations applied (`migrations-accounts` for ACCOUNTS). */
export class FakeD1 {
  db = new DatabaseSync(":memory:");
  batches = 0;

  constructor(migrations = "migrations") {
    const dir = join(import.meta.dirname, "..", migrations);
    for (const f of readdirSync(dir).sort()) this.db.exec(readFileSync(join(dir, f), "utf8"));
  }

  prepare(sql: string) {
    return new FakeStatement(this.db, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.batches++;
    this.db.exec("BEGIN");
    try {
      const results = statements.map((s) => s.exec());
      this.db.exec("COMMIT");
      return results;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  rows(sql: string, ...params: (string | number)[]) {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r })) as Record<string, any>[];
  }

  asD1() {
    return this as unknown as D1Database;
  }

  /** The usage counters (stats_days): { day: counts } for every day stored. */
  stats(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.rows("SELECT day, counts FROM stats_days ORDER BY day").map((r) => [r.day, JSON.parse(r.counts)]));
  }
}

/** A fake ETH: serves the samples, records every URL, and can be told to rate-limit after `okCalls` requests. */
export function fakeEth(okCalls = Infinity) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(decodeURIComponent(url));
    if (calls.length > okCalls) return new Response("busy", { status: 503, headers: { "retry-after": "5" } });
    if (url.includes("min-max-allocation-date")) return new Response(readData("samples", "min_max_date.json"));
    if (url.includes("/studyspaces.json")) return new Response(readData("samples", "studyspaces_en.json"));
    if (url.includes("/studyspaces/availability.json")) return new Response(readData("samples", "studyspaces_availability.json"));
    // A room's details (worker/equipment.ts): the three samples, or a room without any equipment.
    const detail = /path=\/v2\/rooms\/([^&]+)/.exec(decodeURIComponent(url));
    if (detail) {
      const file = `room_${detail[1].replaceAll(" ", "_")}.json`;
      return new Response(["room_ML_E_13.json", "room_HG_E_33.1.json", "room_HG_F_1.json"].includes(file) ? readData("samples", file) : '{"tabs":[]}');
    }
    if (url.includes("/v2/rooms")) return new Response(readData("rooms_snapshot.json"));
    if (url.includes("cookpit-pub-services/v1/facilities")) return new Response(readData("samples", "cookpit_facilities.json"));
    if (url.includes("cookpit-pub-services/v1/weeklyrotas")) {
      const facility = new URL(url).searchParams.get("facility");
      const file = ["9", "14", "22"].includes(facility ?? "") ? readData("samples", `cookpit_rotas_f${facility}.json`) : '{"weekly-rota-array":[]}';
      return new Response(file);
    }
    return new Response(readData("samples", "allocations_ML_E_13.json"));
  };
  return { calls, fetch };
}
