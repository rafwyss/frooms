// UZH: the teaching rooms from UZH's booking calendar (3V-Rooms) and the University Library's seat sensors.
//
// The calendar is public: its portal logs every visitor in anonymously (an OpenID redirect chain and a form post, no
// password), and the session cookie that leaves is all the calendar API needs. One request covers one room for a
// month. Times are Zurich wall-clock time although they end in "Z" (a 16:15 lecture is "16:15:00Z"). Each booking
// has a free-text comment with names and emails: it's never read, stored or shown.

import file from "../data/uzh.json";
import snapshotFile from "../data/uzh_rooms_snapshot.json";
import {
  ETH_BACKOFF_MIN_S,
  HTTP_TIMEOUT_MS,
  UZH_BOOKING_URL,
  UZH_CALENDAR_URL,
  UZH_LOGIN_MAX_HOPS,
  UZH_PORTAL_URL,
} from "./config";
import type { Room } from "./catalogue";
import { ROOM_TYPE_NAMES } from "./overrides";
import type { Reading } from "./spaces";
import type { PackedAllocation } from "./store";
import { addDays, type IsoDate } from "./tz";

const LECTURE_HALL = "3430";
const SEMINAR_ROOM = "3420";
const TEACHING_LAB = "3610";
const UNIABILITY = "https://www.uniability.uzh.ch/static/current/buildings";

/** Our UZH areas (data/uzh.json `campuses`), with the calendar filter of each. */
export const UZH_CAMPUSES: Record<string, { filter: number; label: string }> = file.campuses;
export const UZH_AREAS = Object.keys(UZH_CAMPUSES);
export const isUzhArea = (area: string) => area in UZH_CAMPUSES;
export const UZH_OCCUPANCY_URL: string = file.occupancy_url;
/** Buildings drawn as part of another on the map (data/uzh.json map_buildings): KOH is in KOL's outline. */
export const UZH_MAP_BUILDINGS: Record<string, string> = file.map_buildings;
export const mapBuilding = (code: string) => UZH_MAP_BUILDINGS[code] ?? code;

/** One room of the calendar, as stored in KV (`uzh_catalogue`) and in data/uzh_rooms_snapshot.json. */
export interface UzhRoomRaw {
  id: number; // 3V's resource id
  standort: number; // 3V's location id
  title: string; // e.g. 'KOL-F-101 (209 Plätze) **'
  area: string; // our area (UZ, UI, UO)
  url?: string; // UniAbility's page for it, where the snapshot found one
}

export const UZH_SNAPSHOT = snapshotFile as UzhRoomRaw[];

const EXCLUDE = new RegExp(file.exclude.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
const TYPE_OVERRIDES: Record<string, string> = file.room_types;

// 'KOL-F-101 (209 Plätze) **', 'BIN-0-K.11/12 (36 Plätze)', 'Y21-D-68a (42 Plätze)', 'KOL-E-12'
const TITLE = /^([A-Z][A-Z0-9]{2})-([A-Za-z0-9]{1,2})-([A-Za-z0-9.]+(?:\/[A-Za-z0-9.]+)*)(?=\s|$)(.*)$/;
const SEATS = /\((?:min\.\s*\d+\s*\/\s*max\.\s*)?(\d+)\s*(?:\/[^)]*)?(Plätze|Sitzplätze|Personen)?/;

export interface UzhTitle {
  building: string;
  floor: string;
  room: string; // '101', 'K.11/12'
  code: string; // 'KOL-F-101'
  seats: number | null;
  unit: string | null; // 'Plätze' (seats) or 'Personen' (people standing: an event space)
  rest: string; // what follows the code, e.g. 'EV Senatszimmer (40 Plätze)'
}

export function parseTitle(title: string): UzhTitle | null {
  const m = TITLE.exec(title.trim());
  if (!m) return null;
  const [, building, floor, room, rest] = m;
  const s = SEATS.exec(rest);
  return {
    building,
    floor,
    room,
    code: `${building}-${floor}-${room}`,
    seats: s ? Number(s[1]) : null,
    unit: s?.[2] ?? null,
    rest: rest.trim(),
  };
}

/** The single rooms a combined room ('K.11/12', '62/68/70') is made of: 'K.11', 'K.12'. */
export function roomParts(room: string): string[] {
  const [head, ...tail] = room.split("/");
  if (!tail.length) return [room];
  const prefix = head.includes(".") ? head.slice(0, head.lastIndexOf(".") + 1) : "";
  return [head, ...tail.map((t) => (t.includes(".") ? t : prefix + t))];
}

/** Lecture hall from `lecture_hall_min_seats` seats, else seminar room; teaching labs and data/uzh.json overrides apart. */
function typecodeOf(id: number, t: UzhTitle): string {
  if (TYPE_OVERRIDES[String(id)]) return TYPE_OVERRIDES[String(id)];
  if (/Labor|Praktikum/i.test(t.rest)) return TEACHING_LAB;
  return (t.seats ?? 0) >= file.lecture_hall_min_seats ? LECTURE_HALL : SEMINAR_ROOM;
}

const snapshotUrls = new Map(UZH_SNAPSHOT.filter((r) => r.url).map((r) => [r.id, r.url!]));

/**
 * The calendar's rooms as frooms rooms. Left out: what isn't a teaching room (event spaces counted in people, foyers,
 * apéro areas, data/uzh.json `exclude`), titles without a room code, and combined rooms whose parts are listed too
 * (booking a part shows on the combination as well, so it would only double the list).
 */
export function parseUzhCatalogue(raw: UzhRoomRaw[], area: string | null = null): Room[] {
  const parsed = raw
    .filter((r) => area === null || r.area === area)
    .map((r) => ({ r, t: parseTitle(r.title) }))
    .filter((x): x is { r: UzhRoomRaw; t: UzhTitle } => !!x.t && x.t.unit !== "Personen" && !EXCLUDE.test(x.r.title));
  const single = new Set(parsed.filter(({ t }) => !t.room.includes("/")).map(({ t }) => `${t.building}-${t.floor}-${t.room}`));
  const seen = new Set<string>();
  const out: Room[] = [];
  for (const { r, t } of parsed) {
    if (t.room.includes("/") && roomParts(t.room).some((p) => single.has(`${t.building}-${t.floor}-${p}`))) continue;
    if (seen.has(t.code)) continue; // the same room under two titles
    seen.add(t.code);
    const typecode = typecodeOf(r.id, t);
    out.push({
      area: r.area,
      region: r.area,
      building: t.building,
      floor: t.floor,
      room: t.room,
      seats: t.seats,
      typecode,
      type: ROOM_TYPE_NAMES[typecode] ?? typecode,
      code: t.code,
      url: r.url ?? snapshotUrls.get(r.id) ?? `${UNIABILITY}/${t.building}/`,
      uzh: { id: r.id, standort: r.standort },
    });
  }
  return out;
}

/** The rooms of one calendar answer (a campus filter), as stored. */
export function roomsOfModel(model: unknown, area: string): UzhRoomRaw[] {
  const out: UzhRoomRaw[] = [];
  for (const loc of (model as any)?.StandortList ?? []) {
    for (const r of loc?.RessourceList ?? []) {
      if (typeof r?.Id === "number" && typeof r?.Title === "string") {
        out.push({ id: r.Id, standort: Number(loc.Id), title: r.Title.trim(), area });
      }
    }
  }
  return out;
}

interface UzhBlock {
  Id: number;
  Vorlauf: string | null; // set-up time before the booking (bookings only)
  BeginnEffective: string;
  EndeEffective: string;
  Nachlauf: string | null;
  StatusFarbe: string | null; // a booking's colour; closures have none
}

/** '2026-11-10T10:15:00Z' (wall-clock, despite the Z) -> '2026-11-10T10:15:00'. */
const wall = (v: string) => v.replace(/(\.\d+)?Z$/, "").slice(0, 19);

/**
 * One room's blocks as ETH-shaped allocations (worker/store.ts PackedAllocation): bookings (with their set-up and
 * clear-down time) as type 2, closures (outside opening hours, holidays) as type 8. No titles: UZH's only say "belegt"
 * (and its comments are private). A block crossing midnight comes twice (start and end part); it's kept once. The
 * blocks of a recurring closure share their id, so it's the id with the times that tells them apart.
 */
export function packBlocks(blocks: unknown[]): PackedAllocation[] {
  const seen = new Set<string>();
  const out: PackedAllocation[] = [];
  for (const b of blocks as UzhBlock[]) {
    if (!b || typeof b.BeginnEffective !== "string" || typeof b.EndeEffective !== "string") continue;
    const key = `${b.Id} ${b.BeginnEffective} ${b.EndeEffective}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const closed = b.Vorlauf === null && !b.StatusFarbe;
    const from = wall(closed ? b.BeginnEffective : (b.Vorlauf ?? b.BeginnEffective));
    const to = wall(closed ? b.EndeEffective : (b.Nachlauf ?? b.EndeEffective));
    if (to <= from) continue;
    out.push([from, to, closed ? 8 : 2]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The blocks of room `id` in a calendar answer for that room. */
export function blocksOf(model: unknown, id: number): unknown[] | null {
  const lists = [(model as any)?.RessourceList ?? [], ...((model as any)?.StandortList ?? []).map((s: any) => s?.RessourceList ?? [])];
  for (const list of lists) for (const r of list) if (r?.Id === id && Array.isArray(r.BlockList)) return r.BlockList;
  return null;
}

const CAMPUS_DAY = "2001-01-01";
const CAMPUS_TIMEOUT_MS = 30_000;

/** The sensor widget of a closed library says so instead of giving a reading. */
export const isClosedWidget = (html: string) => /value:\s*'geschlossen'/i.test(html);

/** 'ca. 75% frei von 220' (the UB's sensor widget) -> 25 % full of 220 seats. */
export function parseOccusense(html: string, at: number): Reading | null {
  const m = /ca\.\s*(\d{1,3})\s*%\s*frei\s+von\s+(\d+)/i.exec(html);
  if (!m) return null;
  const free = Math.min(100, Number(m[1]));
  const capacity = Number(m[2]);
  return {
    people: Math.round((capacity * (100 - free)) / 100),
    capacity,
    pct: 100 - free,
    status: null,
    trend: null,
    measured_at: at,
    active: true,
  };
}

export class UzhError extends Error {}

/** UZH asked us to slow down (429/503), or we're still waiting after it did. */
export class UzhRateLimited extends UzhError {
  constructor(readonly until: number) {
    super(`UZH rate limit, backing off until ${new Date(until).toISOString()}`);
  }
}

/** The session expired (the calendar answered 401); log in again. */
class SessionExpired extends UzhError {}

type Jar = Map<string, Map<string, string>>; // host -> cookie name -> value

function keepCookies(jar: Jar, url: string, resp: Response) {
  const host = new URL(url).host;
  const cookies = jar.get(host) ?? new Map<string, string>();
  for (const line of resp.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  jar.set(host, cookies);
}

const cookieHeader = (jar: Jar, url: string) =>
  [...(jar.get(new URL(url).host) ?? new Map<string, string>())].map(([k, v]) => `${k}=${v}`).join("; ");

const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/**
 * Client for UZH's calendar and the library sensors. `before` is awaited before every request, so the caller can
 * pace and budget them (a login is 7). The session (the calendar host's cookies) can be handed in and read back, so
 * it outlives one run.
 */
export class UzhClient {
  session: string | null;
  constructor(
    private readonly userAgent: string,
    session: string | null = null,
    private readonly before: () => Promise<void> | void = () => {},
  ) {
    this.session = session;
  }

  private async send(url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
    await this.before();
    const resp = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": this.userAgent, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      throw new UzhRateLimited(Date.now() + Math.max(ETH_BACKOFF_MIN_S, Number.isFinite(retryAfter) ? retryAfter : 0) * 1000);
    }
    return resp;
  }

  /** The portal's anonymous login: follow the redirects with their cookies, then post the authorisation form. */
  async login(): Promise<void> {
    const jar: Jar = new Map();
    let url = UZH_PORTAL_URL;
    let init: RequestInit = {};
    for (let hop = 0; hop < UZH_LOGIN_MAX_HOPS; hop++) {
      const resp = await this.send(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookieHeader(jar, url) } });
      keepCookies(jar, url, resp);
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        await resp.body?.cancel();
        url = new URL(location, url).href;
        init = {};
        continue;
      }
      if (!resp.ok) throw new UzhError(`UZH login: HTTP ${resp.status} at ${new URL(url).pathname}`);
      const page = await resp.text();
      const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
      const fields = [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)];
      if (action && fields.some(([, name]) => name === "code")) {
        url = new URL(decode(action), url).href;
        init = {
          method: "POST",
          body: new URLSearchParams(fields.map(([, name, value]) => [name, decode(value)])).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        };
        continue;
      }
      // The portal page itself: logged in.
      const session = cookieHeader(jar, UZH_BOOKING_URL);
      if (!session) throw new UzhError("UZH login: no session cookie");
      this.session = session;
      return;
    }
    throw new UzhError("UZH login: too many redirects");
  }

  private async calendarOnce(params: Record<string, string>, timeoutMs?: number): Promise<unknown> {
    const url = `${UZH_CALENDAR_URL}?${new URLSearchParams(params)}`;
    const resp = await this.send(url, {
      headers: { Cookie: this.session ?? "", IsAnonymousRequest: "True", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    }, timeoutMs);
    if (resp.status === 401 || (resp.status >= 300 && resp.status < 400)) {
      await resp.body?.cancel();
      throw new SessionExpired("UZH session expired");
    }
    if (!resp.ok) throw new UzhError(`UZH calendar: HTTP ${resp.status}`);
    return resp.json();
  }

  /** A calendar request, logging in first (or again) when there's no valid session. */
  async calendar(params: Record<string, string>, timeoutMs?: number): Promise<unknown> {
    if (!this.session) await this.login();
    try {
      return await this.calendarOnce(params, timeoutMs);
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      this.session = null;
      await this.login();
      return this.calendarOnce(params, timeoutMs);
    }
  }

  /** One room from `from` to `to` (inclusive), as allocations. */
  async room(r: { id: number; standort: number }, from: IsoDate, to: IsoDate): Promise<PackedAllocation[]> {
    const model = await this.calendar({
      from: `${from}T00:00:00.000Z`,
      to: `${addDays(to, 1)}T00:00:00.000Z`,
      mode: "2",
      standortId: String(r.standort),
      id: String(r.id),
      displayFullDay: "false",
    });
    const blocks = blocksOf(model, r.id);
    if (!blocks) throw new UzhError(`UZH calendar: room ${r.id} missing from the answer`);
    return packBlocks(blocks);
  }

  /**
   * Every room of one campus: the calendar of a day long past, which lists every room with (almost) no bookings,
   * so it's a fraction of today's size (about 0.6 MB for Zentrum, 2-3 s instead of 5 s for a day, 12 s for a week).
   */
  async campus(area: string): Promise<UzhRoomRaw[]> {
    const model = await this.calendar({
      mode: "Day",
      from: CAMPUS_DAY,
      to: addDays(CAMPUS_DAY, 1),
      filtersettingId: String(UZH_CAMPUSES[area].filter),
      anlassId: "",
    }, CAMPUS_TIMEOUT_MS);
    const rooms = roomsOfModel(model, area);
    if (!rooms.length) throw new UzhError(`UZH calendar: no rooms for ${area}`);
    return rooms;
  }

  /** Any JSON from the library's server (its location list). */
  async json(url: string): Promise<unknown> {
    const resp = await this.send(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new UzhError(`UB: HTTP ${resp.status}`);
    return resp.json();
  }

  /** One library sensor's widget: its reading, "closed", or null if it has neither. */
  async sensor(id: string, at = Date.now()): Promise<Reading | "closed" | null> {
    const resp = await this.send(`${UZH_OCCUPANCY_URL}?id=${encodeURIComponent(id)}`);
    if (!resp.ok) throw new UzhError(`UB sensor ${id}: HTTP ${resp.status}`);
    const html = await resp.text();
    return isClosedWidget(html) ? "closed" : parseOccusense(html, at);
  }
}
