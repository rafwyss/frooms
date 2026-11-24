// Central settings for the frooms Worker. Mirrors app/config.py.

export const TZ = "Europe/Zurich";

export const BASE_URL = "https://ethz.ch/bin/ethz/roominfo";
export const HTTP_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT_REQUESTS = 4;

export const CATALOGUE_TTL_S = 24 * 3600;
export const ALLOCATIONS_TTL_S = 10 * 60;
export const MIN_MAX_TTL_S = 24 * 3600;

export const DEFAULT_AREA = "Z"; // Zürich Zentrum
// The only locations frooms shows (CHOICES.md): rooms, study spaces and menus elsewhere are neither fetched nor stored.
export const AREAS = ["Z", "H"];
export const AREA_LABELS: Record<string, string> = { Z: "ETH Zentrum", H: "ETH Hönggerberg" };
// The two Zentrum campuses are one place for students: their mensas are listed, compared and mapped together.
export const MENSA_PARTNERS: Record<string, string> = { Z: "UZ", UZ: "Z" };
/** The areas whose mensas show in `area`'s mensa list: its own, and its Zentrum partner's. */
export const mensaAreas = (area: string): string[] => (MENSA_PARTNERS[area] ? [area, MENSA_PARTNERS[area]] : [area]);

// Lecture halls and seminar rooms. Meeting rooms (2110) are opt-in.
export const DEFAULT_TYPECODES = ["3430", "3420"];
// The room types Meet offers (its More filters, in this order: meeting room, seminar room, lecture hall), and those
// picked on a first visit. Meeting rooms stay opt-in. Computer rooms are listed in Study (STUDY_ROOM_TYPES in app.js).
export const MEET_TYPECODES = ["2110", "3420", "3430"];
export const FILTER_DEFAULT_TYPECODES = ["3420", "3430"];

// The map counts a room as free only if it stays free at least this long from the chosen time.
export const MAP_MIN_FREE_MINUTES = 120;

export const SHORT_GAP_MINUTES = 20;
export const FREE_SOON_MINUTES = 30;

// Workers Free allows 50 subrequests per request; keep headroom for catalogue and min-max lookups.
export const MAX_ROOMS_PER_REQUEST = 45;
export const MAX_BUILDINGS_PER_REQUEST = 10;

// Scheduled prefetch (Cron Trigger every 2 minutes): every room in the catalogue is fetched in the
// background, a few per run, so visitors never cause requests to ETH for the coming month.
// All rooms get one fetch per day (after midnight) covering today to PREFETCH_DAYS_AHEAD days ahead
// (a month costs ETH one request per room, about as fast as a week); only these types, which get
// booked at short notice, are refreshed during the day, for today and tomorrow, this often (seconds): seminar rooms
// and lecture halls every 30 minutes (seminars get booked into both at short notice; lecture halls were only fetched
// once a day until 2026-11-21), meeting rooms hourly. About 16 refreshes per run, within PREFETCH_ROOMS_PER_RUN.
export const PREFETCH_REFRESH_INTERVALS_S: Record<string, number> = { "3420": 1800, "3430": 1800, "2110": 3600 };
// UZH's rooms of these types are refreshed every UZH_REFRESH_INTERVAL_S (worker/uzhprefetch.ts).
export const UZH_REFRESH_TYPECODES = ["3420", "2110"];
export const PREFETCH_DAYS_AHEAD = 31;
export const PREFETCH_RUN_INTERVAL_S = 120; // the Cron Trigger in wrangler.jsonc
export const PREFETCH_ROOMS_PER_RUN = 20;
export const PREFETCH_GAP_MS = 2000; // pause between two ETH requests
// A refreshed room's today or tomorrow older than this counts as stale during the day (the prefetch has stalled, or ETH
// doesn't answer). Stale days are still shown, marked with when they were fetched (`stale` in the answers).
export const PREFETCH_MAX_AGE_S = 2 * 3600;
// Any other stored day older than this counts as stale (the nightly fetch has stalled).
export const NIGHTLY_MAX_AGE_S = 36 * 3600;
// Stored days are kept this many days after they're over, as a booking history; past dates are served from it.
// They're deleted once a day (the delete scans the whole table, so it doesn't run every 2 minutes).
export const HISTORY_DAYS = 31;
// Visitors can pick dates from HISTORY_DAYS ago to this many months ahead (within ETH's own range).
export const MONTHS_AHEAD = 4;
// Quiet hours (Zurich): only fetch rooms that don't have today's data yet, so the night costs one pass.
export const PREFETCH_QUIET_HOURS = { from: 22, to: 6 };
// Experiment (worker/experiment.ts): until this day (exclusive), each daytime run also re-checks a few rooms
// that aren't refreshed, to measure how often their bookings change during the day.
export const EXPERIMENT_UNTIL = "2026-11-12";
export const EXPERIMENT_CHECKS_PER_RUN = 2;
// After ETH answers 429/503, wait at least this long (or longer if Retry-After says so).
export const ETH_BACKOFF_MIN_S = 120;
// Requests to ETH a single isolate may make per minute on behalf of visitors (non-prefetched rooms, other days).
export const ON_DEMAND_PER_MINUTE = 30;

// Study spaces, libraries and mensas (worker/spaces.ts), from ETH's student-workspace occupancy page. Both feeds
// cover every space in one request. ETH caches the list for an hour and the occupancy for 5 minutes.
export const STUDYSPACES_URL = "https://ethz.ch/bin/ethz/studyspaces.json?lang=en";
export const OCCUPANCY_URL = "https://ethz.ch/bin/ethz/studyspaces/availability.json";
export const SPACES_CATALOGUE_TTL_S = 3600;
// A study-space list with fewer than this share of the stored one's spaces is taken for a partial answer (on
// 2026-11-21, during an outage, ETH sent 38 of 66) and not stored, unless ETH keeps sending it for SPACES_SHORT_ACCEPT_S.
export const SPACES_MIN_SHARE = 0.8;
export const SPACES_SHORT_ACCEPT_S = 24 * 3600;
// The prefetch fetches the occupancy once at least this long has passed (with 2-minute runs: every 6 minutes by day,
// every 16 at night). Every reading is kept in the occupancy table as a history.
export const OCCUPANCY_INTERVAL_S = 300;
export const OCCUPANCY_NIGHT_INTERVAL_S = 900;
// A reading older than this (by ETH's own timestamp) isn't shown; some sensors stop reporting for weeks.
export const OCCUPANCY_MAX_AGE_S = 900;
// Categories as on ETH's page: libraries (3100), mensas and cafeterias (3300), everything else is an open study space.
export const SPACE_CATEGORIES: Record<string, "library" | "mensa"> = { "3100": "library", "3300": "mensa" };
// ETH's campus codes for the study spaces -> the room catalogue's areas.
export const CAMPUS_AREAS: Record<string, string> = { ZZ: "Z", ZH: "H" };

// UZH (worker/uzh.ts): the teaching rooms from UZH's booking calendar (3V-Rooms) and the University Library's seat
// sensors. Its own prefetch runs on the menu Cron Trigger (MENU_CRON), after the menus, with its own backoff.
export const UZH_BOOKING_URL = "https://uzh.book.3vrooms.app";
export const UZH_PORTAL_URL = `${UZH_BOOKING_URL}/default/Anonymous/Calendar/PortalFind`;
export const UZH_CALENDAR_URL = `${UZH_BOOKING_URL}/default/api/v1.0/calendar`;
export const UZH_LOGIN_MAX_HOPS = 12;
// At most this many requests to UZH's calendar per run (a login takes 7 of them), one at a time, this far apart.
export const UZH_REQUESTS_PER_RUN = 10;
export const UZH_LOGIN_REQUESTS = 8;
export const UZH_GAP_MS = 1000;
export const UZH_CATALOGUE_TTL_S = 24 * 3600;
// UZH's seminar and meeting rooms (UZH_REFRESH_TYPECODES) are refreshed for today and tomorrow this often during the
// day, about 3 per run. A refreshed day older than UZH_MAX_AGE_S counts as stale.
export const UZH_REFRESH_INTERVAL_S = 2 * 3600;
export const UZH_MAX_AGE_S = 3 * 3600;
// The library sensors (all of them, one request each, on the library's own server) by day and at night.
export const UZH_OCCUPANCY_INTERVAL_S = 600;
export const UZH_OCCUPANCY_NIGHT_INTERVAL_S = 1800;

export function userAgent(contact?: string): string {
  const c = (contact ?? "").trim();
  return `frooms/1.0 (+https://github.com/rafwyss/frooms${c ? "; " + c : ""})`;
}

// Menus (worker/menus.ts) from ETH's gastronomy system, Cookpit, the source of ETH's own menu pages. A second Cron
// Trigger (MENU_CRON, between the room prefetch's runs, with its own CPU budget) fetches one place per run, three weeks
// at a time: hourly by day, every 6 hours at night. About 340 requests a day.
export const COOKPIT_URL = "https://idapps.ethz.ch/cookpit-pub-services/v1";
export const COOKPIT_CLIENT = "ethz-wcms";
export const MENU_CRON = "1-59/2 * * * *";
export const MENU_INTERVAL_S = 3600;
export const MENU_NIGHT_INTERVAL_S = 6 * 3600;
export const MENU_QUIET_HOURS = { from: 20, to: 6 };
export const MENU_WEEKS = 3; // from this week's Monday
export const MENU_FACILITIES_TTL_S = 24 * 3600;
// Stored menu days are kept this long, then deleted (once a day, with the facility list).
export const MENU_HISTORY_DAYS = 60;
// Dishes cheaper than this (in CHF, their lowest price) aren't full meals (a salad by the 100 g, a side): the API leaves
// them out of every menu and card (worker/menus.ts isFullMeal). The stored menus keep them.
export const MIN_MEAL_PRICE = 5;
// /api/menu and /api/menus change at most once an hour per place.
export const MENU_CACHE_S = 600;
// Dish photos, for today's and tomorrow's dishes only (MEAL_IMAGE_DAYS from today): resized to this width when an
// Images binding is configured, cached for a day.
export const MEAL_IMAGE_DAYS = 2;
export const MEAL_IMAGE_WIDTH = 640;
export const MEAL_IMAGE_CACHE_S = 24 * 3600;

// UZH's menus (worker/uzhmenus.ts) from ZFV's food2050 pages, which UZH's mensa site links to (no API key needed).
// Their own Cron Trigger (UZH_MENU_CRON, with its own CPU budget): a few pages per run, one at a time. A weekly page
// per mensa and meal: this week's hourly by day (MENU_INTERVAL_S, MENU_NIGHT_INTERVAL_S at night), the next two
// weeks' every 6 hours; and a dish's page once, for its prices. About 350 requests a day.
export const FOOD2050_URL = "https://app.food2050.ch/en/zfv/universitat-zurich";
export const UZH_MENU_CRON = "3-59/4 * * * *";
export const UZH_MENU_REQUESTS_PER_RUN = 3;
export const UZH_MENU_GAP_MS = 1000;
export const UZH_MENU_LATER_INTERVAL_S = 6 * 3600;
// A dish page that gave no prices is tried again after this long (a dish without prices is still shown).
export const UZH_MENU_PRICE_RETRY_S = 24 * 3600;
// A dish of today or tomorrow without a photo has its page read again after this long (food2050 adds photos late).
export const UZH_MENU_PHOTO_RETRY_S = 6 * 3600;
// UZH's dish photos: food2050's storage bucket, and the form of their object names, which /api/meal-image accepts.
export const FOOD2050_PHOTO_URL = "https://storage.googleapis.com/dish-images-prod/";
export const FOOD2050_PHOTO = /^dish-media\/zfv\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._-]{1,120}$/;

// Occupancy reports (worker/reports.ts, POST /api/report): a report counts for REPORT_WINDOW_MS (one per browser,
// place and kind in that time: a newer one replaces it); the detail view's log shows REPORT_LOG_MS. Reports are only
// shown with an answer for (about) now: `at` within REPORT_NOW_MS of the present.
export const REPORT_WINDOW_MS = 2 * 3600_000;
export const REPORT_LOG_MS = 4 * 3600_000;
export const REPORT_NOW_MS = 5 * 60_000;
// Overall cap per day, so a flood from many addresses can't fill the database (the per-IP limit is REPORT_LIMITER).
export const MAX_REPORTS_PER_DAY = 2000;

// Room equipment (worker/equipment.ts) from ETH's room details (/v2/rooms/<path>): a few rooms per prefetch run, in
// the quiet hours only, each again after EQUIPMENT_TTL_S. Stored in one KV key, "equipment".
export const EQUIPMENT_PER_RUN = 10;
export const EQUIPMENT_TTL_S = 30 * 24 * 3600;

// "Usually this full" (worker/usual.ts): the averages over the past USUAL_LONG_DAYS and USUAL_SHORT_DAYS, weighted
// half and half; a slot with fewer than USUAL_MIN_READINGS readings has no value.
export const USUAL_LONG_DAYS = 61;
export const USUAL_SHORT_DAYS = 7;
export const USUAL_MIN_READINGS = 3;
