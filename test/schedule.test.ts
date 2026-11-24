// Which Cron Trigger runs what: wrangler.jsonc's crons and worker/index.ts's dispatch agree.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MENU_CRON, UZH_MENU_CRON } from "../worker/config";
import worker, { type Env } from "../worker/index";
import { clearStoreMemory } from "../worker/store";
import { FakeD1, FakeKV, readData } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOW = Date.UTC(2026, 10, 11, 11, 0); // Wednesday 11 November, 12:00 in Zurich

let db: FakeD1;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  clearStoreMemory();
  db = new FakeD1();
  calls = [];
  vi.stubGlobal("fetch", async (url: string) => (calls.push(String(url)), new Response("", { status: 500 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = (): Env => ({ ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher, ROOMS: new FakeKV().asKV(), DB: db.asD1() });
const scheduled = (cron: string) => worker.scheduled!({ cron, scheduledTime: NOW, noRetry() {} } as ScheduledController, env(), ctx);

it("has the three Cron Triggers the Worker dispatches on", () => {
  const crons = /"crons":\s*(\[[^\]]*\])/.exec(readData("..", "wrangler.jsonc"))![1];
  expect(JSON.parse(crons)).toEqual(["*/2 * * * *", MENU_CRON, UZH_MENU_CRON]);
});

it("runs only UZH's menu prefetch on its own cron, and nothing of ETH's", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  // During food2050's backoff the run stops before any request.
  db.db.prepare("INSERT INTO meta (key, value) VALUES ('uzh_menus', ?)").run(JSON.stringify({ backoffUntil: NOW + 60_000 }));
  await scheduled(UZH_MENU_CRON);
  expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^UZH menu prefetch skipped/)]);
  expect(calls).toEqual([]);
});
