# frooms

*frooms* (short for "free rooms") is a web app that shows where to study, meet and eat at ETH and UZH. On a phone the **campus map** fills the screen, with a **results sheet** over its lower half (drag it, or click its grabber, to see more of the list or of the map), the search and the campus on top, and four tabs at the bottom: **Study** (libraries and open study spaces, with occupancy estimates, then computer rooms, seminar rooms and lecture halls free for an hour or more), **Meet** (lecture halls, seminar rooms and, if picked, meeting rooms free now or at a chosen time for a chosen duration, by building, for the whole location at once), **Eat** (mensas and cafeterias) and **You** (starred places, About, feedback and contact). On wide screens (≥ 1000 px) the same parts sit in a left column and the map takes the rest. Each list's time and buildings are one line at its top ("Now · all buildings"), which opens the filters on a click. It can be installed on a phone's home screen.

**Live:** https://frooms.ch

Data comes from ETH's public room-info API (`https://ethz.ch/bin/ethz/roominfo`). ETH blocks cross-origin requests, so a backend fetches from ETH and serves the page. There are two interchangeable backends for the same `static/` frontend:

- **Cloudflare Worker** (`worker/`, TypeScript): the deployed version.
- **FastAPI** (`app/`, Python): the original local app, used by the research scripts. **Frozen:** new features (such as the study spaces) are built in the Worker only, and the Python app is no longer extended.

For the room logic both still give identical answers. `scripts/golden.py` writes the Python output to `test/golden/`, and the TypeScript tests compare against it.

## Web version (Cloudflare Worker)

Requires Node 22.12+.

```bash
npm install
npm run dev        # http://127.0.0.1:8787
npm test           # vitest: logic, timezone, parity with Python, routes
npm run typecheck
npx wrangler deploy
```

Pushing to `main` runs the tests and deploys (see `.github/workflows/ci.yml`; needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets).

Differences from the local app:

- **Scheduled prefetch.** ETH rate-limits its API (HTTP 503 with `Retry-After`), so visitors never trigger requests for the coming month. A Cron Trigger runs every 2 minutes (`worker/prefetch.ts`). Each run fetches about 20 rooms, one at a time and 2 s apart, starting with the most out-of-date. After midnight it fetches every room in the catalogue (about 450) once, with one request covering today to 32 days ahead (as fast as a shorter range for ETH). During the day (06:00–22:00) it refreshes the rooms that get booked at short notice, for today and tomorrow, spread evenly over the runs (`PREFETCH_REFRESH_INTERVALS_S`, about 16 per run): seminar rooms and lecture halls (about 210) every 30 minutes, meeting rooms (about 50) every hour; labs, computer rooms and the other types keep the night's data. The page shows "data as of …" accordingly. When a room's data is older than it should be (ETH not answering, or the prefetch stalled: `PREFETCH_MAX_AGE_S`, `NIGHTLY_MAX_AGE_S`), frooms still shows the last bookings it has rather than none: the answers mark it (`stale`, and `stale_since` on the room), and the page says "Bookings as of Fri 14:54" on the room and notes it next to "data as of".
- **Storage:** allocations live in D1 (`DB`, schema in `migrations/`), one row per room and day, kept for a month after the day as a booking history (past dates are served from it; older rows are deleted once a day), together with the prefetch state, the experiment log, the study spaces' occupancy history, the occupancy reports and "usually this full" (see "Reports, equipment and usual occupancy"). Workers KV (`ROOMS`) holds the room catalogue (refreshed daily), the list of study spaces (hourly) and the rooms' equipment. After adding a migration, apply it with `npx wrangler d1 migrations apply fruum --remote` before pushing.
- **Rooms not loaded yet** are shown as "not loaded yet" (status `pending`) instead of being fetched on demand.
- **On demand:** dates more than a month ahead are fetched when asked, but at most 30 ETH requests per minute per Worker instance.
- **Experiment (until 11 November 2026):** each daytime run also re-checks 2 rooms that aren't refreshed and logs every booking that appeared or disappeared since the last fetch; the regular refresh is logged the same way as a baseline (`worker/experiment.ts`). Results: `/experiment` (page) and `/api/experiment` (JSON). It stops by itself after `EXPERIMENT_UNTIL`.
- **Backing off:** when ETH answers 429/503, both the prefetch and the on-demand requests stop for at least 2 minutes, or longer if `Retry-After` says so. They never retry into a rate limit.
- `GET /api/status` shows the prefetch progress and any active backoff.
- `/api/free` serves at most 45 rooms per request (Workers Free allows 50 subrequests). The page sends one request per building, and splits a larger building by room type.
- 30 `/api/free` and `/api/room` requests per minute per IP; more get HTTP 429.
- Set the `FROOMS_CONTACT` variable in `wrangler.jsonc` to put a contact address in the User-Agent sent to ETH.
- **Kill switch:** set `FROOMS_DISABLED` to `"1"` and redeploy. The API then answers 503 with a friendly message and the prefetch stops (e.g. if ETH asks us to stop).
- The page is a PWA: `static/manifest.webmanifest`, icons in `static/icons/` (re-render with `scripts/make_icons.sh`), and `static/sw.js`, which caches only the app shell, never room data.
- Static security headers live in `static/_headers`.
- The privacy notice is `static/privacy.html` (served at `/privacy`, English and German, linked from the You tab's footer and the account menu), with its own `static/privacy.css` since the CSP allows no inline styles. Change it in the same step as anything it promises.

## Study spaces and mensas (Worker only)

The Study and Eat tabs come from ETH's [student workspaces](https://ethz.ch/students/en/campus/workspaces-for-students/occupancy-student-workspaces.html) page, which loads two JSON feeds, each covering every space in one request:

| Feed | Content | Fetched by the prefetch |
|---|---|---|
| `https://ethz.ch/bin/ethz/studyspaces.json?lang=en` | 66 spaces: name, room, seats, opening hours, features, notices | hourly, into KV (`spaces`) |
| `https://ethz.ch/bin/ethz/studyspaces/availability.json` | occupancy readings of the spaces with sensors (about 13) | every 5 minutes (15 at night) |

- **Categories** as on ETH's page: room type 3100 is a library, 3300 a mensa or cafeteria, everything else an open study space. Mensas only appear in the Eat tab.
- **Our own names and categories** override ETH's in `data/overrides.json`, keyed by ETH's room id, so places read the way students know them (e.g. ETH's "Catering" mensa is the study space "HG Lobby", and the Rondell is a study space too). The Worker and the scripts both read it. It also holds our **English names**: ETH's study space names are German even in its English feed, so each space has a `name` here (proper names like Grüner Boden or Clausiusbar stay as they are; a new space shows ETH's name until we add one). Room types are named there too (`room_types` by typecode). The Worker applies them where it reads the catalogue (`renameCatalogue`), so the catalogue functions still match the Python app. The catalogue is still fetched with `lang=de`, because ETH's English type names are awkward ("Seminars / Courses", "Draw").
- **Open or closed** is worked out from the opening hours (`worker/spaces.ts`), including meal times and 24-hour access with an ETH card. If ETH's list says a space stays closed until a later day (a holiday or closure), it's closed for the rest of that day.
- **Occupancy** is ETH's estimate in steps of 20 %, never the head count, coloured green below 60 %, yellow at 60 % and red from 80 % (ETH's own status is only kept in the history). It is shown only for "now", only for open spaces, and only if ETH's reading is at most 15 minutes old (`OCCUPANCY_MAX_AGE_S`); some sensors stop reporting for weeks.
- **History:** every reading is kept in the D1 table `occupancy` (`migrations/0003_occupancy.sql`): one row per sensor and fetch, with our fetch time (`at`) and ETH's own timestamp (`measured_at`), even if the reading hasn't changed. That's about 3,000 rows a day, kept indefinitely, for our own "usually this full" estimates (`worker/usual.ts`) and to check ETH's data quality, e.g.:

  ```bash
  # Per sensor: readings, how old ETH's data was when we fetched it, and how often it was frozen
  npx wrangler d1 execute fruum --remote --command "SELECT space, COUNT(*) AS readings, ROUND(AVG(at - measured_at) / 60000.0, 1) AS avg_lag_min, COUNT(*) - COUNT(DISTINCT measured_at) AS repeats FROM occupancy GROUP BY space ORDER BY space"
  ```
- `/api/spaces` never asks ETH: it serves the stored list and the latest readings (`meta` key `spaces_live`). Until the first prefetch, it uses the bundled list `data/spaces_snapshot.json`.
- Invite links for spaces (`/share?space=MMB79&…`) get their own preview images (`static/og/<bg>/space-<id>.jpg`).
- UZH's rooms have previews of their own on UZH's backgrounds (`"university": "UZH"` in `assets/share-backgrounds/backgrounds.json` and `meals.json`); the app picks a background of the location's university. A place without an image of its own (UZH's libraries, for now) gets its background's general card (`static/og/<bg>/_any.jpg`, "Find a free room at UZH" on UZH's).
- Mensas invite for their meal instead: "Invite for lunch" (or dinner) with an optional time ("now" during the meal, then every quarter hour until it ends). The link (`/share?space=MMB79&meal=lunch&t=1215&…`) previews as "Lunch at Mensa Polyterrasse at 12:15?" with its own image (`static/og/meal/<bg>/space-<id>-<meal>-<time>.jpg`, on the backgrounds in `assets/share-backgrounds/meals.json`); opening it shows the mensa's detail view with that meal's menu open. `scripts/make_share_images.py` renders one per mensa, meal it serves and quarter hour, using the meal times Cookpit publishes (about 600 images: each quarter hour, now, and today, tomorrow or a weekday without a time).

### Reports, equipment and usual occupancy

- **Occupancy reports** (`worker/reports.ts`, `migrations/0006_reports.sql`): `POST /api/report` takes `{ kind, place_kind, place, area, value, client, estimate? }`, always about now: a level for rooms and spaces (`level`: 0 free, 1 crowded, 2 full), a percentage for study spaces (`pct`, 0 to 100) and a rating of frooms' estimate (`rating`, -5 much emptier than frooms says to +5 much fuller, never shown). JSON only, same origin, the place must exist in that area. `client` is a random id the browser keeps (32 to 64 letters or digits); only its SHA-256 is stored (`reporter`), never the IP address. One report per browser, place and kind counts within 2 hours (`REPORT_WINDOW_MS`): a newer level or percentage replaces the older one, a second rating is ignored. 10 per minute per IP (`REPORT_LIMITER`) and 2,000 a day in all (`MAX_REPORTS_PER_DAY`), else 429. Kept indefinitely as usage data. The answer carries the place's new summary. `DELETE /api/report` with the same fields but `value` removes the browser's own report of that place and kind from the past 2 hours (ratings too; the same limits), answers `{ ok, removed, summary }`, and where sign-in is on takes back what the report earned: its +3, every 👍's +1 (and `likes_received`), its link and votes (`removedReportStatements` in cred.ts; voters keep their +1). A report replaced by another reading carries its +3 to the new row, so removing it after a change takes the +3 too.
- **In the answers** (for `at` within 5 minutes of now, else `null`): `reports` on every space of `/api/spaces`, every room of `/api/map?rooms=1` and `/api/room`: `{ levels: [free, crowded, full], pct, n_pct, last }` over the past 2 hours, ratings left out; `null` when there are none. `GET /api/reports?place_kind=room&place=HG+E+33.1` lists one place's reports of the past 4 hours (`{ id, at, kind, value }`, newest first, no reporter) with the summary, for the detail view's log. Where sign-in is on, each entry also has `up`, `down` (👍 and 👎) and `trusted`, and signed in `mine` and your `vote` (1, −1 or 0); see "Report votes".
- **Equipment** (`worker/equipment.ts`): ETH's room details (`/v2/rooms/<path>`) say which rooms have presentation monitors, projectors, HDMI, a wireless presenter, black- or whiteboards and flipcharts. The room prefetch fetches 10 rooms per run in the quiet hours (22:00 to 06:00), after its rooms, never during a backoff; each room again after 30 days (`EQUIPMENT_PER_RUN`, `EQUIPMENT_TTL_S`), Meet's types first. All of it is one KV key, `equipment` (`{ [path]: { at, flags } }`, one write per run that fetched something). Every room of `/api/map?rooms=1` and `/api/room` has `equipment` (the flags, or `null` while unknown; UZH's always `null`), and `&equip=screen` leaves out the rooms known to have neither a screen nor a projector (unknown ones stay, for the page's "Equipment unknown" group).
- **Day blocks** for the schedule bar: every room of `/api/map?rooms=1` and `/api/room` has `blocks`, the day of `at` as `[from, to, kind]` in minutes since midnight (Zurich), `"b"` booked or `"c"` closed, bookings merged with bookings and closures with closures, cut to the day (`dayBlocks` in `worker/availability.ts`); `null` when the room's day isn't stored. A whole Zentrum day is about 120 KB.
- **Usually this full** (`worker/usual.ts`): once a day (the room prefetch's first run after midnight, in a batch of its own) one SQL statement per 80 sensors rebuilds the D1 table `usual` from the past 61 days of `occupancy`: per space and weekday, each quarter hour's average and count over the 61 days and over the past 7 days, in Zurich time (across a change to or from summer time), at ETH's own reading time, a frozen sensor's repeated reading once. One row per space and weekday (about 1,400 row writes a day). The value is half the 2-month average and half the past week's, the 2 months alone when the past week has no reading for that quarter hour, and none with fewer than 3 readings. `/api/spaces` gives every space with a history `usual: { pct, curve }` for the weekday of `at`: the value at its quarter hour and the day's 96 quarter hours (`null` where unknown).
- **Microwaves** (`data/microwaves.json`, by hand): `/api/spaces` has `microwaves`, the location's entries (`id`, `building`, `name`, `count`, `place` they belong to, `floor`, `at` in the campus drawing's metres, `check` for a provisional spot); both Zentrum campuses get Zentrum's. On the map, under the mensa filter, zoomed in each entry is its own 20 px marker with its count where it is (never hidden by labels: just beside one it would cover, `besideBoxes` in lib.js); zoomed out (below 0.75 px per metre, or while a building's markers would be closer than 24 px, `microwaveSpots` in lib.js) each building has one round label with the total below its mensa labels instead, the first to hide when labels crowd. A spot's marker opens its own page (below); a building's round label opens the building's view at its "Microwaves" section. On a floor plan, the entries of that building and level are drawn where they are. Pin mode drags them too (`static/map/pins.json` `microwaves`, over `at`).
- **Nutrition:** every dish in the stored menus has `nutrition: { kcal, kj, protein, fat, sat_fat, carbs, sugar, salt }` per 100 g (`null` values where the source has none, `null` for a dish without any). Cookpit sends it with the menus (`energy` in kJ, `energy-outdated` in kcal); UZH's comes from each dish's food2050 page with its prices (`parseDishPage`; kJ worked out from kcal). A UZH dish whose page hasn't been read yet has no `nutrition` field; the menu prefetch reads every dish page once for it, also those that have their prices already. `/api/menu` and `/api/menus` pass it on.
- **Climate rating:** UZH's dishes have `climate`: food2050's rating `"low"`, `"medium"` or `"high"` (`dish.stats.food2050climateImpact.rating` on the weekly page, so no extra request; food2050 bases it on Eaternity's CO₂ data), `null` when a dish has none. ETH's dishes have no `climate` field. food2050's °C figure (`temperatureChange`, on the dish page only) isn't taken.
- **Full meals only:** `/api/menu`, `/api/menus` and the cards' flagship dish leave out dishes whose lowest price is under CHF 5 (`MIN_MEAL_PRICE`, `isFullMeal` in `worker/menus.ts`: salads by the 100 g, sides); dishes without any price stay. The stored menus keep them, so changing the limit needs no refetch.
- **The mensas' order** (`data/overrides.json` `mensa_order`, by place id): `/api/spaces` and `/api/menus` send the location's list as `order` (UZH Zentrum gets Zentrum's). Zentrum: Mensa Polyterrasse, Obere Mensa, Untere Mensa, Clausiusbar, Archimedes, Platte 14, food&lab, Rämi 59, Polysnack, Tannenbar, Insieme, Dozentenfoyer; Hönggerberg: food market, FUSION meal.
- **Our own study spaces** (`data/overrides.json` `extra_spaces`), all of category `workspace` (Study's "Workspaces" section, after the rooms): the Student Project Houses, SPH Zentrum (building SPHZ, in FHK: cut out of ML's outline, `carve` in `data/map/campuses.json`) and SPH Hönggerberg (SPHH, HPZ's outline), are appended to ETH's list by `parseSpaces`. Both are open around the clock (`hours`), show "Open for SPH projects" (`open_text`) and the Makerspace's hours as their opening hours (`shown_hours`). Fabrik (LEO B 8.1, building LEO, drawn from OSM's "ETH LEO") is open Mon–Fri 08:00–18:00 and has no official page (no `info_url`: no Official info button). IPZ Hangar (the ETH Hangar at the Innovationspark Zürich in Dübendorf) is outside every campus: `also_in` lists it in both ETH locations (one entry per location; search shows it once), `map: false` keeps `scripts/make_map.py` from looking for building IPZ, and its `notice` says it's not on the map yet.
- **Microwave pages** (`/?microwave=MW-MM-1&area=Z`, `renderMicrowaveView` in places.js): every spot of `data/microwaves.json` has a page, opened from its row in Eat and in a building's view, its marker on the map and search ("Einstein", group "Microwaves"; `/api/index` has `microwaves`). It shows the queue its reports say (the length with the most reports of the past 2 hours, ties to the longer, `queueLevel` in lib.js), where it is, the place it belongs to, the queue reports and their log, and three actions: Find on campus, Report queue (Free, ~5 min, ~10 min, 15 min+: report kind `queue`, values 0 to 3, `place_kind` `microwave`, no migration) and Star (the You tab's "Microwaves"). No check-in, no invite. `/api/spaces`' `microwaves` carry each spot's `reports` summary (`queue`: the counts of each length) for now.
- **UZH libraries' card hours**: outside a library's regular hours but inside its UZH-card hours (UB Sciences after 17:00), `/api/spaces` has it open with `card_only` and `card_uzh`, and the page says "Open with UZH card".
- **A mensa missing from ETH's study-space list** (Mensa Polyterrasse, MMB79, since November 2026) is still listed: `eateryPlaces` makes it a place with menus only under the space's id, with Cookpit's name, building and floor, open when its menus say so (the eatery's `area` in `data/overrides.json` is needed for that).

### Working locally

Locally D1 is empty, so Meet's rooms are "not loaded yet" and Eat has no menus. `node scripts/seed_local.ts` (Node 24;
Node 22 needs `--experimental-strip-types`) writes `build/seed_local.sql`: invented bookings for today and the next two
days of every Zentrum room in a building with floor plans, the Cookpit and food2050 samples' menus moved to today and
tomorrow (a weekend day gets Friday's), 60 days of invented occupancy history for the spaces with sensors with
"usually this full" built from it, a live reading of ETH's sensors as of now (so open sensor spaces have frooms'
estimate for 15 minutes), and a handful of occupancy reports for two rooms (HG E 33.1, HG F 1) and two study spaces
(GLC Atrium with percentages and a rating, Grüner Boden with levels) over the past 4 hours; and `build/seed_equipment.json`, invented equipment for those rooms. Load them with
`npx wrangler d1 migrations apply fruum --local` (once), `npx wrangler d1 execute fruum --local --file
build/seed_local.sql` and `npx wrangler kv key put equipment --path build/seed_equipment.json --binding ROOMS --local`. The bookings count as fresh for 2 hours, like the prefetch's; seed again after that. Nothing is
sent anywhere, and it never touches the remote D1.

`node scripts/page_check.mjs [--tab study|rooms|mensa|you] [--eval "<js>"] [--account <fixture>] [path …]` takes
screenshots of the local page (`npm run dev` running) in headless Chrome, at 390 × 844 (touch) and 1440 × 900, light and
dark, into `build/shots/`, and prints the page's errors and what `--eval` returns. It drives Chrome over the DevTools
protocol with Node's own `WebSocket`, no dependency; the other options are at the top of the script. There is no local
sign-in, so `--account new|active|gold` answers the account's calls (`/api/me`, `/api/friends`, …) from
`scripts/fixtures/<fixture>/*.json` through the protocol's `Fetch` domain and lets everything else through to the local
Worker; the check-in is kept for the run, so checking in, changing the end and checking out work, and each call that
isn't a GET is printed. `new` has just set up, `active` is checked in at HG E 41 with friends and a request, `gold` has
no check-in; `signed-out` (or no option) intercepts nothing. `active` also answers every place's Report log
(`reports.json`, with your own, a trusted and voted lines) and its votes; `anon` answers only the log, as signed out.
`active` and `anon` also answer `/api/meal-ratings` (`meal-ratings.json`: named dishes' ratings, made-up ones for the
rest) from the local menus, and `active` takes ratings for the run. `new`, `active` and `gold` answer Street cred
(`cred.json`, kept for the run: check-ins, votes and invites add to it and answer `cred`, so the toast shows; joining and
leaving the leaderboards work); `active` and `gold` also the leaderboards (`cred_board.json`, `recent` and `all`; `gold`
is 63rd in Recent) and `active` the log (`cred_log.json`, 64 entries, filtered by day). `--drag "x1,y1,x2,y2"` then drags with real input
events (a finger on the phone, the mouse wide) and `--after "<js>"` prints what the page says after it.
`--keys "Escape,Tab,Shift+Tab,Enter"` presses real keys (their default actions happen) before `--after`; `--size 720x450`
shoots one other size at scale 2 instead of the two (a 1440 × 900 window at 200 % zoom); `--reduce-motion` emulates
`prefers-reduced-motion`. `--account welcome` has just signed in for the first time (`profile_needed`, no username), for
the welcome view and the tutorial's way back from signing in (`/?tutorial=friends&step=5#welcome`).

To try the prefetch locally: `npx wrangler dev --test-scheduled`, then `npx wrangler d1 migrations apply fruum --local` and `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/2+*+*+*+*"`. This makes real requests to ETH.

## The page (Worker only)

- **Tab line:** one muted line under the sheet's head says what the tab is for (`TAB_BLURBS` in app.js): Study "Find libraries and places to study on campus", Meet "Find free rooms to meet with your team", Eat "Compare menus and find your perfect meal", You "Check-ins, friends and your favourite places on campus" (under the title "Your frooms"). Detail views and search hide it.
- **Frame:** `static/index.html`, `static/sheet.js` (the results sheet), `static/app.js` (tabs, lists, filters), `static/map.js`, `static/places.js` (detail views), `static/account.js`, `static/friends.js` and `static/checkin.js` (accounts, below), `static/picker.js` (the date and time picker) and `static/lib.js` (pure logic, tested in `test/lib.test.ts`), plain scripts without a build step.
- **Time:** the filters' Time field is the Now chip and two buttons, the date ("Fri 13.11.") and the time ("10:15"); while Now is on they show the current ones, muted. A click opens a picker under the row (one at a time, `static/picker.js`): a month calendar (Monday first, the selected day navy, today ringed, days outside `/api/dates` disabled; arrows, Enter and Escape work) or a time wheel, two drums for the hours and the minutes in steps of 5 that follow the finger 1:1 (36 px per value, `WHEEL_STEP_PX`), glide on after a flick (the distance grows with the square of the release speed, `wheelGlide` in lib.js; none with `prefers-reduced-motion`) and snap to a value; both drums wrap around (23 → 00, 55 → 00, nothing carries). A click on a value above or below moves there, the mouse wheel moves one value per notch, the drums are spinbuttons for the keyboard (arrows, Page Up and Down by six, Home and End). Picking anything turns Now off; the wheel stays open and the list refreshes 300 ms after it settles (`WHEEL_REFRESH_MS`). A click anywhere outside the open picker and the two buttons keeps what it shows and closes it (a gliding drum lands where it was heading, a waiting refresh runs at once; `commitPicker` in app.js), at the end of the click, so the click still does what it's on (a tab, a row, the map); a press that turns into a scroll closes it 350 ms after it ends (`OUTSIDE_PRESS_MS`). Escape closes either picker. The chosen date and time live in `state.date` and `state.time` (not saved: a reload is Now again), and the detail views' and invites' `at` come from them as before.
- **Study's rooms:** below the study spaces (and Study's mensas, which have no Menu button there; their view has it), three groups: computer rooms, seminar rooms and lecture halls free for 60 minutes or more from the chosen time (`STUDY_ROOM_TYPES`, `STUDY_MIN_FREE` in app.js), each sorted like the other lists and then longest free first, five shown until "All 23 computer rooms". They come with the map's `/api/map?rooms=1&types=3650,3420,3430` answer (one request; the map's counts stay at 2 hours, the list picks the hour from the rooms' minutes, `studyRoomGroups` in lib.js), and the building chips count and filter them with the study spaces. Rooms free for less, busy or without data are Meet's. Beyond the stored month one line says "Rooms this far ahead are in Meet."; UZH has no computer rooms, so that group isn't there.
- **Meet's room types:** More filters offers Meeting room, Seminar room and Lecture hall only (`/api/types` answers `MEET_TYPECODES`); seminar rooms and lecture halls are on by default, meeting rooms opt-in. A stored choice with other types (computer rooms, from before) keeps the offered ones, or the defaults when none is left (`keptTypes` in lib.js). A "Screen or projector" chip (`renderEquipment`, `equip=screen` on the request, rooms without equipment data in a collapsed "Equipment unknown" group; `EQUIPMENT_FILTER` in app.js turns it off again) filters on the rooms' equipment from ETH's room details (filled in over the first nights after release); a room's view shows "Equipment: screen, projector, …" when its answer has `equipment` (`equipmentText` in lib.js).
- **The Eat tab** (`renderEat` in app.js): two buttons at the top, "Compare menus" (the comparison) and "Find your meal" (the meal search, below), then "Your mensas" (starred mensas and cafeterias, hidden when none), "Mensas near you" (nearest first once the position is known, else "Mensas" in the location's order, `order` above, with places not in it after by name; `sortPlaces` in lib.js), "Cafeterias & bars" and "Microwaves near you" (or "Microwaves"; `/api/spaces`' `microwaves` by building, nearest building first, `microwaveGroups` in lib.js; a row like "3 microwaves · Einstein" with its reported queue and floor opens the spot's page). Open places first, closed at the end of each group in the same order. **The comparison** (`renderCompare`): a window of fixed size (90 % of the height, at most 1100 px wide; phones the full height less 16 px) whose table scrolls both ways; the mensa chips are starred first, then nearest, else in the location's order (`order`) and the rest alphabetically (`compareOrder` in lib.js), on one line that scrolls sideways; until you pick, the columns are your starred mensas of the location, or your one star and Mensa Polyterrasse (the Obere Mensa when the star is Polyterrasse), or Mensa Polyterrasse and the Obere Mensa (Hönggerberg: food market and FUSION meal; `compareDefault` in lib.js); your picks are kept per location (`comparePicks` in the stored choices); columns are 240 px (phones 200 px); a mensa's name opens its day view, a dish opens a lightbox with its photo (today's and tomorrow's), description, values per 100 g (`nutritionText`) and allergens. The day and week views show the values per 100 g as a muted line under each dish that has them. Cookpit cuts long descriptions off mid-word in its own data ("… | Pete..."): the cut part is left out ("…, Grated cheese, …", `dishDesc` in lib.js). Eat has no building filter: the Buildings field is hidden, the filter line says the time only, and the stored `spaceBuildings.mensa` is ignored. On the map a mensa's label opens its view, and in Eat a building does too, also on wide windows.
- **Find your meal** (`renderMealSearch` in app.js; the menu panel's third view, `openMenu(null, opener, null, { view: "search" })`): the comparison's window and meal stepper, then three rows of chips and the results. **Sort** (one on): Nearest (the default with a position; without one it's the server's order, the chip says "Nearest (allow location)" and a click asks for the position), Price, Protein, Carbs, Calories (per 100 g, highest first), Climate impact (UZH's `climate` rating, lowest first; ETH's dishes go under "No climate rating"). Tapping the sort that's on turns it around. **Filter** (any number): Vegan, Vegetarian (vegan counts), Meat, Fish (dish types, any of those on), Gluten-free (no allergen naming gluten or a cereal with it) and Lactose-free (no allergen naming milk or lactose), with a line saying they go by the mensas' allergen lists. **Presets**: Budget-maxx (Price), Protein-maxx (Protein), Carb load (Carbs), each without filters, and "Your selection" (the sort and filters as they are, on whenever they are no named preset); the star in a preset makes it *the* food preference (one at a time, `mealPref: { preset, sort, filters }` in the stored choices, `cleanMealPref` in lib.js). The results are the dishes of every place of the location with a menu for that meal (in Zentrum both campuses'), from `/api/menus`, ranked by `rankDishes` in lib.js (ties: the nearer place, then the cheaper dish): the type mark and line, the name (a click opens the lightbox), the mensa with its distance (a click opens its day view, whose foot leads back), the values per 100 g (`nutritionText`) and the price for the chosen price group; dishes without a value for the sort come last under "No nutrition data" ("No price" for Price, "No climate rating" for Climate impact). Sorted by climate impact, a result shows its rating ("Low climate impact") in place of the values per 100 g. In the day and week views a UZH dish has a "Climate impact" expandable below its allergens (and "Nutrition & Allergens" in the week view): the rating with food2050's colour, and what it means. The choice lasts while the page is open and starts from the starred preference.
- **"Your meal" on the cards:** while a food preference is starred, a mensa's card shows "Your meal: Garden · Dal · 7.50" instead of the flagship dish: the mensa's top dish under the preference (`yourMeal` in lib.js; a "Nearest" preference takes the cheapest) for the meal the card is about (`cardMealOf`, the Worker's pick), with that dish's photo. A mensa where no dish passes the filters, or none has the value, keeps its flagship dish. `loadYourMeals` in app.js reads the day's `/api/menus` (the panel's cache, 10 minutes; at most three days) after each refresh of Eat and draws the cards again only when the dishes changed.
- **Mensa cards** (`mensaCard` in app.js): about twice a row's height, a 96 px photo left, then the name (with its star, and "UZH" or "ETH" for the other Zentrum campus's), the status in meal words (`eatStatus` in lib.js: "Lunch until 13:30" amber, "Lunch at 11:15" plain, "Lunch tomorrow at 11:15" or "Closed today" grey; cafeterias "Open until 18:30"), the flagship dish from `/api/spaces`' `flagship` ("Street · Fish & Chips · 9.50", the price for the chosen price group) and the room and distance. The photo is the mensa's own when `static/mensa-photos/index.json` lists its id, else the flagship dish's (`/api/meal-image`), else a tile with its initials in its university's colour (`placeInitials` in lib.js). No Menu button on the card: the view has it. A mensa that is a study space between its meals says "Study space now, until 11:15" as a second line in its view.
- **Mensa photos:** put a photo named after the place's id (`MMB79.jpg`, `UM1.png`) into `assets/mensa-photos/` (git-ignored) and run `python3 scripts/make_mensa_photos.py` (needs Pillow): it writes 192 px square WebP tiles and `index.json` into `static/mensa-photos/`. The tiles are git-ignored: the current ones may not be published, so they live in the private repo's `private-assets/` (copy new ones there), and `scripts/private_assets.sh` copies them in (CI's deploy does too). `index.json` stays in git.
- **Building chips:** the filters' Buildings field is a row of chips: "All" (on when nothing is picked; a click clears the choice), then starred buildings with a small star, then the rest alphabetically, each with its count (`buildingChips` in app.js, the order from `orderBuildingChips` in lib.js). On phones it's one line that scrolls sideways and fades out at the right edge; on wide windows it wraps.
- **The schedule bar:** every room row (Meet, Study's rooms, a building's view, You) and the room's view show the day as a strip under the row: free green, bookings red, the building's closures grey, from 07:00 to 22:00 (`BAR_FROM`, `BAR_TO` in lib.js; blocks outside are cut to it), with a navy needle at the chosen time (`scheduleBar` in app.js, from the room's `blocks` in the `/api/map?rooms=1` and `/api/room` answers; no bar when the day isn't stored). The view's bar has the hours under it. Blue (`--meeting` in style.css) is defined and unused: it's for scheduled meetings, later. The bar is hidden from screen readers (the status says it) and its tooltip lists the blocks ("08:15–10:00 booked").
- **Reports on the rows:** left of a room's "free until …" and a study space's "Open until …" stand the mannequins (`people` in app.js): one grey figure without reports, one green when people reported it free, two orange for crowded, three red for full (the level with the most reports in the past 2 hours, ties to the fuller one; `reportLevel` in lib.js, from the answers' `reports`). Only for now: for a chosen time the rows show none (the You tab is always now). On a space with frooms' estimate the estimate's bar is navy (one colour, whatever the level) and the mannequins stand beside the bar, so sensor and people are told apart; without level reports the mannequins follow the average of the percentage reports (crowded from 60 %, full from 80 %), and "Reported about 70 % full (3 reports)" is a line under the bar. For a future time a space with a history shows "usually about 55 % full" (navy, paler) in place of the live estimate (`usual.pct`).
- **Reports in the views:** below the bookings (rooms) or the hours (spaces), "frooms users' occupancy reports": "full [•••] 5×, crowded [••] 2× in the past 2 hours" (only the levels reported), for spaces with the estimate also "Reported about 70 % full (3 reports, past 2 hours)", or "No reports in the past 2 hours."; for a chosen time "No reports for future times.", for a closed space "No reports while it's closed." A "Report log" button opens a box of at most 160 px that scrolls, with the past 4 hours from `/api/reports` ("14:05 full" with its mannequins, "14:05 about 70 %"), never saying who reported; at each line's end 👍 and 👎 with their counts (buttons signed in, "You" on your own report), and a trusted reporter's lines with the round frooms icon (see "Report votes").
- **Sending reports** (`reportControls` in places.js, `sendReport` in app.js): for now only, a room that is free or busy (not while its building is closed) and an open space have "Report occupancy" in their view's actions. It opens, in the reports section, three big buttons Free, Crowded and Full with their mannequins (one click sends it), or, on a space with frooms' estimate, a navy slider from 0 to 100 % in 5 % steps that starts at the estimate, and Send. ("Rate the estimate", which asked the same of spaces with an estimate, was removed on 2026-11-20; the Worker still takes `rating` reports from old pages.) The answer's summary updates the view and the list's rows at once (and stands in for the place's summary for 2 minutes, so a list loaded from a cached answer doesn't hide it). The page keeps a random id (`client`, 32 hex digits, made on the first report) and the reports it sent in the past 2 hours (`reports`) in its preferences, so the view shows "You reported crowded at 14:05" with that button pressed, and another click changes it; a round red ✕ beside that line takes it back (`removeMyReport` in app.js, `removeButton` for the ✕), for every kind: a level, a percentage and a microwave's queue. **Right after checking in** to a room or space, the "Checked in!" window first asks the same (`checkinReportStep` in checkin.js): Free, Crowded, Full, or for a space with frooms' live estimate the slider, with Skip and "All reports" (the place's view at its reports); a report sent there is the same one the place's view shows as yours. Then the end time and invite as before. Errors: "Too many reports right now, try again in a minute." (429), "You're offline.", "Couldn't send your report."
- **Usually this full:** a study space with a sensor shows, under its opening hours, the day's curve from `usual` (`usualSection` in places.js): one thin navy bar per quarter hour from 07:00 to 22:00, the chosen time's amber, and "Usually about 55 % full at this time." (or "Not enough data yet." while the history is too short; a sensor without any `usual` rows yet shows the section with that line). It's the history, so it shows for future times too.
- **Detail views:** every list row, building label (on phones), Near you row and floor plan shape opens one view per place in the sheet: a room (status, the schedule bar, seats, type, the day's bookings from `/api/room`, the reports), a study space, library, mensa or cafeteria (status, occupancy, hours, meal times, menu, usually this full, the reports), or a building (its study spaces, its rooms free long enough, its mensas and cafeterias, each opening its own view). Actions at the bottom in rows of two, only those that apply: Official info and Show on floor (rooms and study spaces with floor plans) or Show on campus (mensas and cafeterias, and places without plans); Report a problem (the feedback form, with "Wrong room info" picked and the place named) and Report occupancy; Star and Invite. On wide windows clicking a building filters the list; its view is reachable from "HG Details →" above the list.
- **Addresses:** each place has its own: `/?room=HG+E+33.1&area=Z`, `/?space=MMB79&area=Z`, `/?building=HG&area=Z` (`placeUrl` and `parsePlaceUrl` in lib.js). Opening a place is a history entry, so Back returns to the list where it was; from a building or Near you the next place stacks, otherwise it replaces. Reloading shows the same place; an unknown one shows the list with a short note. `?buildings=HG,CAB` still opens Meet filtered to those.
- **Search:** the field in the top bar opens a search over every room, study space, workspace, mensa, building and microwave spot of all five locations (`/api/index`, loaded on the first search and kept in memory; the service worker doesn't cache it). Case, spaces, dots, hyphens and accents don't matter (`hge33`, `HG E 33.1` and `hg e33.1` find the same room; `grun` finds Grüner Boden); names match from the start of a word. The exact code first, then codes starting with it, then names; within that the current location, then starred places. At most 30, grouped. A result opens its view, switching location if needed; Back from there returns to the list. An empty field lists the starred places (`searchPlaces` in lib.js). Things rather than names ("meeting room", "Hörsaal", "library", "microwave", "coffee", "cheap vegan", "Irchel": English and German words, `SEARCH_INTENTS` and `MEAL_INTENTS` in lib.js, from 3 letters) also give "Go to" results (`searchIntents`) that open the fitting tab with its filters and map filter ("… near you" asks for the position and sorts by distance), Find your meal with a sort and filters, the comparison, a location, Study's Workspaces ("makerspace", "workspace") or the tutorial ("tutorial", "tour", "Anleitung", a journey's own phrases such as "add friends"; and for now every help word, "help", "FAQ", "Hilfe", which `plans/FAQ_NOTES.md` lists for a future FAQ) (`runIntent` in places.js); they come first when the query is one of their words, after the places otherwise. A query typed before the index has arrived says "Loading…" and is searched as soon as it's there; without a connection it says "Search needs a connection." and the next keystroke tries again. On phones search opens the sheet at full height at once and focuses the field without scrolling the page; while it's open the view ends at the top of the keyboard (`visualViewport`, `fitSearchView` in places.js), and the viewport meta's `interactive-widget=resizes-content` lets Android shrink the page instead of panning it. The page's scripts share one global scope, so no two of them may declare the same top-level name (`test/scripts.test.ts`).
- **Stars:** the star in a room's, study space's, mensa's, cafeteria's or building's view (in its head and its action row) keeps it in the You tab, at most 40 over all kinds, newest first, stored with the other choices in `localStorage` only (`STORE_KEY`, field `stars`: kind, id, area, name, building, and a room's type or a space's category, so the You tab can show a row before its data arrives; a building's star has its code as `id` and `building`, and its name from the campus drawing). Starred places come first in every list (`sortPlaces`) with a small star. In Study and Meet the places in a starred building come next (`starredBuildings`), and Meet's building groups put starred buildings right after those with a starred room. The You tab groups them (rooms, libraries, study spaces, workspaces, "Your food preference", mensas and cafeterias, microwaves, buildings; by location when there are several; the food preference is the starred preset of Find your meal, with a line saying what it does, and a click opens the search with it), with their status now: one `/api/spaces` per location with a starred space, one `/api/map?rooms=1&types=…` per location with a starred room, and for starred buildings the map's counts (open study spaces, rooms free 2 h+) from that answer or a plain `/api/map`, every 5 minutes while it's open. A place that's gone shows its stored name, "no longer listed" and Remove. The map highlights the starred places' buildings.
- **Invites** (`/share?…`, unchanged in the Worker) open the place's detail view with the sender's sentence above it ("Lunch at Mensa Polyterrasse at 12:15?", `inviteTitle` in lib.js, the same as the Worker's title), at the sender's time; a meal invite opens that meal's menu too. The address becomes the place's, and the receiver's own stored choices aren't changed. Links without a location find it in `/api/index`.

## Map view (Worker only)

The campus map (`static/map.js`) fills the frame on phones, behind the top bar and the results sheet (`static/sheet.js`: three positions, peek, half and full; it sets `--sheet-top` so the map knows its visible part, `visibleBox()` in map.js, which fitting, moving and the campus buttons use), and tapping a building opens its sheet above the results (which go down to peek meanwhile). On wide windows (≥ 1000 px) it sits next to the list, where clicking a building filters the list to it (Shift/⌘ adds it), clicking beside the buildings clears that filter again (`clearPickedBuildings` in app.js). Clicking beside the buildings, or on a building that isn't picked, resets the buildings picked in Study and Meet both, on phones too (a picked building, or Shift/⌘, leaves them). With a place's view open (a room, study space, mensa, building or Near you, also one opened from a mensa's label such as Poly), clicking beside the buildings closes it, however deep, back to the tab's list as it was, on phones too (`placeToList` in places.js); the account's views stay, and clicking its study-space or room count opens that tab for it and hovering a room highlights its building. Each ETH building gets a label: zoomed out only its code, zoomed in also the number of open study spaces (with a dot in ETH's occupancy colour, if the suggested space has a fresh reading) and the number of lecture halls and seminar rooms **free for at least 2 more hours** from the chosen time (`MAP_MIN_FREE_MINUTES`; in Meet, the chosen duration). Labels that would overlap are hidden, keeping the bigger buildings. On phones, tapping a building opens its detail view (see The page). Buttons below the zoom buttons are filters, at most one on at a time (`state.mapLayer`; none by default, which shows the buildings' codes alone): study spaces or rooms add that count to the building labels (greyed when it's zero; a mensa or cafeteria that's a study space right now counts with its building's study spaces). Mensas or cafeterias replace the building labels with labels of their own, each on its pin or else on its building (several stack downwards; where they crowd, the location's mensas in our order go first, `/api/map`'s `order` from `data/overrides.json` `mensa_order`, `placeLabelOrder` in lib.js: Poly before Polysnack before Dozentenfoyer, the Obere Mensa above the Untere, then the rest): amber while serving food, navy while they're a study space, grey with a cross badge when closed (every place shows under its filter, closed or not). A mensa whose building is known by its name shows that name (Mensa Polyterrasse is "Poly", data/overrides.json `buildings.place`). In Zentrum both filters show both universities' places. Tapping one opens its detail view (on wide screens, the Eat tab filtered to its building). Buildings are in their university's colours (`--map-eth-*`, `--map-uzh-*` in style.css): darker when selected (with the frooms navy outline), lighter on the selected campus, palest on the others; building labels are white with the code in the university's colour, and a selected one gets the navy outline. What's left out and why is in [CHOICES.md](CHOICES.md).

- **Data:** `GET /api/map?area=Z[&at=…]` summarises the whole area in one request (`worker/map.ts`), from D1 and the study-space feeds only. It never asks ETH, so it isn't rate-limited; rooms not stored yet count as unknown, and times outside the stored range (the history and a month ahead) have no room counts.
- **Drawing:** one map of the region around all campuses. `static/map/<area>.json` holds a campus's buildings by code (outlines as SVG path strings in the campus's metres, label anchors, sizes) and landmarks. Everything else is in the region's tiles: `static/map/region/index.json` (origin at Zentrum, bounds, tile size, the tiles that have anything) and `static/map/region/<col>_<row>.json` (500 m squares: houses, other university buildings, roads, paths, tram, Polybahn, green, water, cut at the tile's edge; a house goes whole into the tile with its middle). Only the land between the campuses has tiles: the zone within `ZONE_M` (600 m, about a campus's width) of the hull around all the campuses' buildings, after which the detail thins out over `FADE_M` (300 m): paths end first, then squares and service roads, houses, parks and small streets, each at its own random point (`FADE_END`); main roads, rail and water go on to the end. Each tile's `ground` (the inner zone) covers the overview under it, so in the fade the overview shows through. The tiles show at every zoom: those in view load first (with `TILE_MARGIN_M` around it), then the rest, four at a time (`prefetchTiles`). Outside the zone, and until the tiles are in, the overview (`static/map/overview.json`: main roads, rail, rivers, lakes and big forests over the whole region) is all there is. `scripts/make_map.py` builds all of it from OpenStreetMap: `python3 scripts/make_map.py --cache data/cache/osm` (each campus once, then the region in 1.5 km chunks, about 30 Overpass requests; `--cache` keeps the answers for the next run, and `SSL_CERT_FILE=/etc/ssl/cert.pem` helps if Python can't verify Overpass's certificate). ETH buildings are found by their `ETH <code>` tag, and every building with rooms or study spaces must be found or the script fails. The region reaches one Hönggerberg width west of Hönggerberg, 300 m north of Oerlikon, and so far east and south that, fully zoomed out in the bottom-right corner, Zentrum is 2/5 of the view from the right and bottom (`ZENTRUM_FROM_EDGE`). Its input, `data/map/campuses.json`, holds each campus's box, display names, label offsets and landmarks. HG's dome position was taken from the roof faces in the federal solar roof layer (`ch.bfe.solarenergie-eignung-daecher`).
- **Pins:** `static/map/pins.json` moves labels off their building's centre: buildings by code, mensas and cafeterias by id, microwaves by their id (over `data/microwaves.json`'s `at`), in the drawing's metres. To make them, open the site with `?pins`: every label can be dragged (tap one to pick it, "Back on its building" undoes it), the moved ones are kept in the browser, and "Copy pins" copies them to paste into that file. Buildings without an outline in OSM (`not_on_map`) are in the campus file as label only (`"d": ""`, no anchor, `"outline": false`): on the map they show only where a pin puts them, and then work like any other label (counts, tapping opens the sheet) with nothing to highlight. Pin mode lists the area's unplaced ones with a "Place on map" button that drops the label in the middle of the view; "Take off the map" removes it again.
- **Edit mode:** `?edit` (includes pin mode) loads `static/edit.js`, a panel of tools for what the traces can't know: Corners (tap a room, study space or place on a floor plan; drag its corners, pick several with "Add to selection", Shift or "Box select", delete corners, add one after the picked corner, reset the room), Entrance (main or side, pointing in at right angles to the nearest outer wall), Stairs and Lift (new floor-plan icons, shown to everyone), and Microwave (tap the map or a plan; name and count from the panel). Changes show at once and stay in the browser; "Copy edits" gives one JSON for `python3 scripts/apply_edits.py <file>` (or `-` for stdin), which merges the floor changes into `data/floors/edits/<building>.json` and `static/map/floors/<building>.json`, appends the microwaves to `data/microwaves.json` and the moved pins to `static/map/pins.json`. `scripts/make_floors.py` applies `data/floors/edits/` on top of every new trace.
- The campus files, the overview, the region's index and the pins are in the service worker's shell, so the map draws offline (without numbers); tiles seen before are kept as they're fetched.
- **Floor plans** (17 of ETH's buildings: those in `static/map/floors/index.json`, in Zentrum and on Hönggerberg; on the `floor-plan-dev` branch until ETH agrees, see CLAUDE.md): a building listed
  in `static/map/floors/index.json` gets "View floor plans" in its sheet (wide layout: a button on the map while the
  list shows just that building), and "Show on plan" on its suggested room and study space. The floor view draws one
  level over the faded campus: lecture halls and seminar rooms green when free for 2 h+ (pale green when free for less,
  red when booked, grey without data), study spaces navy (grey when closed), mensas and cafeterias green or red. Labels
  show the room's level and number ("E 33.1") or name, zoomed in also until when or how full. The layer buttons become level buttons (top
  floor at the top, a dot where something is free or open); it opens on the level with the most free rooms and open
  spaces, or on the tapped room's. Tapping a shape opens its sheet. Entrances are arrows pointing in (larger at main
  entrances). Where two buildings connect on a level (HG and MM on B), a button with an arrow and the other's code
  switches to its plans on the same level (or the level it names: CLA D is LEE F). The title ("HG · level E") opens a
  menu of the campus's buildings with plans (which frames the new plan), and a click on another one's outline or tag
  switches to it too without moving the map (as do the link buttons), on the level as
  many floors above or below street level (`matchLevel` in lib.js, from `levels` in `static/map/floors/index.json`,
  which `make_floors.py` copies from `data/floors/levels.json`: each building's ground level and level order); the map
  note says "HG F → CAB G" for a second. Every other building of the campus has a small muted tag with its code
  (`renderFloorTags`); those with plans have an eye and are buttons; tags give way to the plan's labels and each other.
  Microwaves on the level are drawn where they are. It's a history entry: Back returns to the campus
  with the building's sheet. Data: `/api/map?…&building=HG` adds `detail` (each room, space and place with its level).
- **Building floor plans:** `python3 scripts/make_floors.py HG` (or `MM`; needs `pip install -r requirements-floors.txt`)
  turns ETH's plan PDFs (`assets/eth-plans/zentrum/HG/HG_<level>_VF_<date>.pdf`, from plan.ethz.ch, not in git) into
  `static/map/floors/HG.json` (committed, ~190 KB) and `index.json`. Its input `data/floors/HG.json` (by hand) pairs
  four plan corners with vertices of HG's OSM outline (all of HG's sheets share one position), and per level gives a
  point in each room, study space or place shown (`seeds`), extra wall lines where a region leaks (`cuts`, also
  polylines), and areas that aren't floor (`outside`: ground beside the basement, roof, voids). Walls are the plans'
  black fills; doors are closed along their swing, windows along the outer wall, and everything is clipped to the OSM
  outline. It fails when a room, study space or place lacks a region, two share one, a region is under 4 m² or over
  1,500 m², or the file passes 250 KB, and writes debug images to `build/floors/` (`HG_<level>.png` as shown,
  `HG_<level>_grid.png` every region in its own colour with a grid in plan points, for finding seeds and cuts).
  `--level E` (or `--draft`) reports problems without failing or writing. When ETH publishes a new plan, drop the
  PDF in, rebuild and check the debug images; cuts may need moving. Per level, `links` puts the button to the next
  building (`{"to": "HG", "at": [x, y]}`, with `"level"` when the other building names that floor differently:
  CLA D ↔ LEE F). Entrances are `entrances` (`{level: [[x, y, "main" | "side"], ...]}`),
  classified on `build/floors/<building>_entrances.html`, which the build writes: it shows the doors in the outer wall
  as blue circles (click: side, main, none; shift-click adds one anywhere) and gives the value to paste in. A level
  with nothing on frooms, no link and no entrance is left out (HG keeps B for the link to MM and C for its entrance
  from Leonhardstrasse). MM's input also has `parts` (Zweistein, MM C 82, is a second shape of Einstein's study space
  MMC81, with its state) and `names`. Where OSM's outline isn't the floor's, `clip` (rings in plan points) replaces
  it and `clip_add` adds to it; a control point can pair with campus metres instead of an outline vertex (ETA E is
  placed through GLC's fit). `shapes` draws a room as a given polygon instead of a traced region (CAB). `--fit` only fits and writes `build/floors/<b>_<level>_fit.png` (the outline drawn
  through the fit, vertices numbered) for picking control points. Scale bars differ per building (`scale_bar_m`:
  10 m on IFW, 15 m on HIT, 20, 25 or 30 m elsewhere); the build checks the fitted scale against each sheet's bar.
- **Distances in the lists:** with the position known, every list puts starred places first, then the nearest buildings (`sortPlaces` in `static/lib.js`, distances from `placeDistances()` in map.js), and rows show the distance to their building. The position is used on load only if the browser already allows it (`navigator.permissions`); otherwise after a click on the locate button.
- **Near you:** the crosshairs button below the zoom buttons shows the person's position (a blue dot, with a circle
  for how exact it is) and opens "Near you" in the sheet: the three nearest buildings with an open study space and the
  three with a room free long enough, nearest first ("here" for the building they're in), from the `/api/map` answer
  the map already has. A row opens that building's view, and Back returns to Near you. On another campus, the map
  switches to it; off campus, the view says how far the nearest one is. The position stays on the device (`static/geo.js`
  does the maths, map.js the rest): it's asked for after the click (or on load when the browser already allows it),
  only while the page is visible, kept in memory and never sent. The campus files carry the projection's `origin` (lat,
  lon of x = y = 0) for this. `static/_headers` allows `geolocation=(self)`.
- **One map, one campus at a time:** every campus is drawn (`drawWorld`), and the view may go anywhere in the region.
  The view works in the selected campus's metres (so pins, floor plans and saved views stay per campus); the other
  campuses and the tiles are placed through their `origin`s (`setActive`). Only the selected campus's buildings are
  labelled and tappable; the others are pale, with one campus tag each ("UZH Irchel"; Zentrum's on HG and KOL), and a
  tap on the tag or any of their buildings switches there. Zoomed out below `CAMPUS_TAG_SCALE`, the selected campus
  shows as its tag too (a tap zooms to it). Campus tags show only where they fit in the visible part; Zentrum's two
  stack when they'd overlap. The list always shows the selected campus.
- **Campus buttons** (`CAMPUS_LINKS` in map.js; the campus button in the top bar opens the list of all five) sit at
  the edge in their campus's direction (from Zentrum: Hönggerberg the way from HG to IFW, Irchel from HG to CHN;
  Irchel: both Zentrum campuses side by side, Hönggerberg and Oerlikon; Hönggerberg: Irchel and ETH Zentrum;
  Oerlikon: Irchel). They're hidden once zoomed in well past the whole-campus view (`LINK_HIDE_ZOOM`,
  `LINK_HIDE_SCALE`) and while their campus's tag is in view. Their arrows point up, down, left or right, whichever
  is closest.
- **Flying between campuses:** switching campus while the map is in view (a campus tag or button, a pale building or
  the list's location) flies there within the one drawing: zoom out, across, and in, to that campus's whole view. Its buildings light up at
  once; labels and buttons fade out meanwhile. A drag, pinch or wheel during the flight stops it where it is and moves
  the map from there (`interruptFlight`); the switch itself still completes, and the labels come back once the new
  campus's data is in. `FLIGHT_SPEED` sets the pace. Between the two Zentrum
  campuses there's no flight: the map stays until the other campus's numbers are in, then swaps in one go
  (`zentrumSwap`), keeping the view if its main building (HG or KOL) is in sight, else jumping there (at least
  `MAIN_BUILDING_SCALE`).

## UZH (Worker only)

Three more locations, **UZH Zentrum**, **UZH Irchel** and **UZH Oerlikon** (areas `UZ`, `UI`, `UO`), with UZH's teaching rooms, the University Library's locations and seat sensors, UZH's mensas with their menus, and a map each. The code is in `worker/uzh.ts` (rooms and the client), `worker/uzhspaces.ts` (libraries), `worker/uzhmenus.ts` (menus) and `worker/uzhprefetch.ts`; the hand-kept settings are in `data/uzh.json`.

| Source | What | How |
|---|---|---|
| [3V-Rooms](https://uzh.book.3vrooms.app/default/Anonymous/Calendar/PortalFind) (`uzh.book.3vrooms.app`) | the booking calendar of UZH's centrally managed teaching rooms (Campuskultur's Raumdisposition), about 190 rooms in three campus filters | the portal logs every visitor in anonymously (redirects, cookies and a form post, 7 requests, no password); the session's cookies then open `/default/api/v1.0/calendar` (401 without them) |
| UB location list (`hbzwwws04.uzh.ch/uzhbibsub/backend/web/bibapi/`) | every University Library location: building, room, seats, regular and UZH-card hours, closures | one JSON request |
| UB seat sensors (`hbzwwws04.ub.uzh.ch/occusense/occusense_progressbar_150.php?id=N`) | 11 sensors, "ca. 70% frei von 220" (or "geschlossen") | one small HTML widget each |
| [food2050](https://app.food2050.ch/en/zfv/universitat-zurich) (`app.food2050.ch`), ZFV's menu app, which UZH's mensa site links to | the menus of UZH's mensas (ZFV runs them): dishes, vegan/vegetarian, allergens, prices for students, staff and external guests | public Next.js pages: a weekly page per mensa, meal and week (no prices), and a page per dish (its prices). ZFV's GraphQL API (`api.zfv.ch`) has the same data but needs a key |

- **Rooms:** a calendar request for one room and a month is about 90 KB. The catalogue (each campus once a day) asks for a day long past, which lists every room with almost no bookings (0.6 MB instead of 1.3 MB for a day, 7 MB for a week). Rooms are keyed by their own code (`KOL-F-101`), in the same D1 tables as ETH's (ETH's paths have spaces, so they can't clash). Left out: event spaces counted in people (Lichthof, Mall), apéro areas, rooms without a code, and combined rooms whose parts are listed too (`BIN-0-K.11/12`). From 100 seats a room is a lecture hall, else a seminar room; teaching labs are teaching labs (`data/uzh.json` overrides by resource id). Links go to [UniAbility](https://www.uniability.uzh.ch/static/current/)'s building page.
- **Times** in the calendar end in `Z` but are Zurich wall-clock time (a 16:15 lecture is `16:15:00Z`; the closures read "ab 13:30 geschlossen" at `13:30Z`). Bookings, with their set-up and clear-down time, become ETH-style allocations (type 2), closures type 8, so the availability logic is shared. A fetched day with no blocks at all is free. A block over midnight comes twice and a recurring closure's blocks share an id, so blocks are told apart by id and times.
- **Privacy:** every booking carries a free-text comment (`Kommentar`) with names and emails. It's never read, stored or shown; the bookings show as "booked". The test fixtures (`data/samples/uzh_*`) are trimmed to the fields we read.
- **Prefetch** (`runUzhPrefetch`): on the menu Cron Trigger, after the menus, so it has its own CPU budget. Per run at most 10 calendar requests, 1 s apart (a login takes 7, so it waits for a run with enough left); like ETH's, every room once a day for a month (after midnight), and the seminar rooms again by day for today and tomorrow, every 2 hours (`UZH_REFRESH_INTERVAL_S`; such a day older than 3 hours isn't shown). About 160 rooms, so the night's pass takes about 35 minutes. The session is kept in D1 (`meta` key `uzh`, with UZH's own backoff after a 429/503); a 401 logs in again. UZH rooms are never fetched on demand: later days than the prefetched month show "no data". The library list is fetched daily (KV `uzh_libraries`), the sensors every 10 minutes by day (30 at night), into the `occupancy` history and `meta` `uzh_spaces_live`.
- **Libraries:** the active UB locations on the three campuses with seats and published hours; a location with several sensors (the Irchel study centre's West and East/South) is one entry per sensor. Open by its regular hours; where it has none (UZH members only), by its UZH-card hours, with a note (`library_notes` where the UB's page says otherwise, e.g. ETH cards at the Irchel study centre). Closed during its listed closures. Occupancy as for ETH (only for now, at most 15 minutes old).
- **Map:** `static/map/UZ.json`, `UI.json`, `UO.json` from `scripts/make_map.py`, which finds UZH buildings by OSM's `UZH-<code>` tag. Where OSM has none, the campus entry in `data/map/campuses.json` names the outline (KOL's untagged outline, relation 123300; BIN and BIM around their address points). KOH is drawn and counted as part of KOL (picking KOL in Meet lists KOH's rooms too, `/api/map`'s `parts`), PLR as part of PLM (`map_buildings`). KO2 is in KOL's OSM outline too but drawn as its own building, cut off it along a line (`splits` in `data/map/campuses.json`). MEN, the Mensa building (Künstlergasse 10), is drawn for its two mensas. Y03, Y04 and Y16 have no outline in OSM: they're label-only buildings, on the map once `static/map/pins.json` places them (see "Pins"); until then only their rooms are listed.
- Refresh the snapshots (`data/uzh_rooms_snapshot.json`, `data/uzh_libraries_snapshot.json`) with `python3 scripts/uzh_catalogue.py`; `--samples` rewrites the test fixtures (avoid).
- **Mensas:** the 12 UZH mensas with menus on food2050 (`data/uzh.json` `mensas`: ids `UM1`…, a `menu_days` key from 100001 so they share ETH's menu tables, food2050's slugs, each meal's time and the regular opening hours, from zfv.ch where it gives them, else from [famoser/Mensa](https://github.com/famoser/Mensa)). Lichthof (closed for building work) and Forum have no menus there and are left out; Atrium (UM12) has pages but no dishes yet. Open and not serving, a UZH mensa is a study space (`study` on its Place; CHOICES.md). **Cafés without menus:** The Yard and Irchel Bar (`data/uzh.json` `cafes`, ids `UC1`…), places of kind "cafe" with `weekHours` (Monday to Friday) instead of menu days, linked to their zfv.ch page. A page's data is in its `self.__next_f.push(…)` scripts: joined, they are React's server payload, one row per line, with the GraphQL answer inside; an object seen before (a category, an allergen) is a reference to it (`$14:props:outlet:…`), which `worker/uzhmenus.ts` follows. Dishes become ETH's `Dish` shape: the category is the line ("Menu 1", "Garden"), vegan and vegetarian from food2050, meat when the dish names one (`namesMeat`: name, or description unless the name says it's a vegetable dish; meat before fish), fish from the allergens, everything else "other". The photo is the dish page's `imageUrl` in food2050's bucket, kept as its object name (`image`, a string where ETH's is Cookpit's numeric id); `/api/meal-image/<name>` serves it like ETH's (today's and tomorrow's dishes only, `FOOD2050_PHOTO` checks the name). A day without dishes has no record, so the mensa is closed then; a day with dishes is open by the mensa's regular hours. Its link goes to its food2050 page.
- **Menu prefetch** (`runUzhMenuPrefetch`): a Cron Trigger of its own (`UZH_MENU_CRON`, every 4 minutes), at most 3 pages a run, 1 s apart. Weekly pages for this week and the next two (`?week=46&year=2026`), this week's hourly by day and every 6 hours at night, the later weeks' every 6 hours; one meal's page replaces that meal in the stored days and keeps the other (the Untere Mensa's lunch and dinner are two pages). Then the dish pages of dishes without prices or without nutrition yet, today's first, each once (one that gives no prices is tried again after a day), and today's and tomorrow's dishes without a photo, again every 6 hours (`UZH_MENU_PHOTO_RETRY_S`, state `photos`). About 350 requests a day. Its state (pages fetched, food2050's backoff after a 429/503) is `meta` `uzh_menus`. A page that can't be read (`UZH menu parse failed` in the log) keeps what's stored. Test fixtures: `data/samples/food2050_*.html`, real pages trimmed to their data scripts.
- **Both Zentrum campuses' mensas together** (`MENSA_PARTNERS` in `worker/config.ts`): on ETH Zentrum and UZH Zentrum, `/api/spaces` also lists the other campus's mensas and cafeterias, marked `partner: true` and with their own `area`; `/api/menus` compares both; the map labels them on the other campus's buildings (drawn plain anyway). The page shows them in the Mensas tab only (not the Study tab), with whose they are ("ETH", "UZH"), and opens them without switching campus; stars and links keep their own area.
- `GET /api/status` has a `uzh` section: rooms, how many are fetched for today, sensors reporting, backoff, and the menu prefetch's last run and backoff.

## Accounts, friends and check-ins (Worker only)

Optional accounts for ETH and UZH members (`plans/PLAN_ACCOUNTS.md` has the decisions; `CLAUDE.md` the registration,
databases and secrets). Everything else works without one.

- **Sign-in** (`worker/auth.ts`): SWITCH edu-ID over OpenID Connect (code flow with PKCE, `client_secret_basic`, the ID
  token checked with Web Crypto). Only people SWITCH reports as `student`, `staff`, `faculty` or `employee` of ETH or
  UZH get in. `GET /auth/login?return=<path>` → SWITCH → `GET /auth/callback`, which sends the page back to `return`
  with `#welcome` (a new person) or `#signin-error=<cancelled|expired|not_member|failed|unavailable>`. Sessions are a
  random token in an HttpOnly cookie (30 days after the last use, renewed at most daily), its hash in D1. `POST
  /auth/logout` ends it. Sign-in works on frooms.ch (`ACCOUNTS`) and the fixed preview host (`ACCOUNTS_DEV`) only;
  elsewhere `/auth/*` and the account endpoints answer 404 `sign_in_off`.
- **Endpoints** (`worker/social.ts`; all `no-store`, every change needs the page's own `Origin`): `GET /api/me`,
  `POST /api/me/profile`, `GET /api/username`, `DELETE /api/me`, `GET`/`PUT /api/me/stars`, `GET /api/people`,
  `GET /api/friends`, `POST /api/friends/requests`, `POST /api/friends/requests/accept`, `DELETE /api/friends/requests`,
  `DELETE /api/friends`, `POST /api/blocks`, `POST`/`PATCH`/`DELETE /api/checkin`, `GET /api/friends/checkins`.
  Other people arrive as `{ username, name: "Raffaele W.", initials, bg, fg, bg2, fg2, metal }`; errors as `{ detail: code }`.
- **The page** (`static/account.js`, `friends.js`, `checkin.js`): the account button at the right of the top bar (the
  person icon, or the bubble with a red dot for friend requests or an unfinished profile; greyed offline) opens a
  menu, signed in or not. Signed in it starts with Friends, frooms Street cred, Profile and Account; signed out with just
  "Sign in" (the "signin" view), and with "Finish setting up" (the "welcome" view) while the profile step is undone. Below
  a line, for everyone: About frooms. ("frooms." as the logo writes it), Tutorial, Send feedback (the feedback form),
  Contact and Privacy (the notice, `/privacy`). These are detail views of kind `account` in the sheet
  (places.js `AREALESS`), without an address of their own: "signin", "welcome" (the first sign-in's username and
  bubble colours), "profile", "account" (sign out, with SWITCH's own sign-out link; delete, with the username typed),
  "friends", "add:<username>" (`/?add=raffi`, the add-a-friend link), "cred" and "cred:log" (Street cred), "checkin", "friendsat:<area|building,…>", and
  "about" (the About text, from `<template id="about-text">` in `index.html`) and "contact" (the address with a copy
  button), which work signed out too: the You tab's footer (About frooms, Send feedback, Contact, Privacy) opens them.
  On phones the wordmark gives its place to the button; on wide windows the search has a row of its own.
- **Stars with the account:** signed in, the account's list counts. The first load after a sign-in in a browser merges
  the browser's stars in (`mergeStars`); each change is sent (`PUT /api/me/stars`, at most every 2 s, the last list
  wins); a change made offline is sent later (localStorage `frooms-account`).
- **People in the page's search** (signed in): a "People" group with matching friends at once (and where they're
  checked in) and other people from `/api/people` (from 3 letters or a whole email address); a result opens
  "person:<username>": a friend with their check-in, anyone else with Add friend. The field then says "Search places
  and friends".
- **Friends:** a search (your friends at once; "More people" from 3 letters or a whole email address), requests
  (Accept, Decline, Withdraw), Remove friend, Block, Report (the feedback form's "Report a person") and your
  add-a-friend link.
- **Check-in:** the round button (bottom right above the tabs on phones, in the top bar on wide windows; hidden while a
  check-in runs, during search and over a place's view) opens "Check in": the places of the building you're in, or of
  the three nearest (the position stays on the device), and a search. A click checks in (`source` nearby, search or
  place) and opens "Checked in!" with 1 h, 2 h, 3 h (the default) or a time on the time wheel (5-minute steps within
  the next 12 hours, `untilClamp` in lib.js; sent 600 ms after the wheel stays put, or when the window closes), and
  the invite. Every room's and space's view has "Check in"; checked in there, "Checked in" (the end time, with Check out
  at the window's bottom left) and a round red Check out (lib.js `actionSpans`: Star 3, Invite 3, Checked in 4, Check
  out 2 of twelve columns). The You tab shows your check-in (its times change the end, the red button checks out) and
  "Friends here now" (nearest first, else this campus and the latest first).
- **Friends on the map:** `/api/friends/checkins` every 2 minutes while the page is visible and signed in. One bubble
  per building above its label (your own with a green ring), merged with a count where they'd overlap (`stackBubbles`
  in lib.js), with its own layer button; a click opens "Friends in HG". The campus buttons and the campus menu count
  friends on the other campuses, and a building's view says "Friends here".
- **Trying it:** only on `https://accounts-preview-fruum.fruum.workers.dev` (`npx wrangler versions upload
  --preview-alias accounts-preview`), with real edu-IDs; there is no local or fake sign-in. Locally the page shows
  "Sign-in works on frooms.ch only"; `scripts/page_check.mjs --account <fixture>` shows it signed in (see "Working
  locally").

### Street cred

Points for what signed-in people do that others can see or use (`plans/PLAN_STREET_CRED.md`, `worker/cred.ts`,
`migrations-accounts/0002_cred.sql`). The Worker awards them where the action happens; signed-out actions earn nothing
and aren't remembered. A day is the Zurich calendar day.

| Action | Points | Rule and cap |
|---|---|---|
| Becoming friends | 25 each | Once per friendship, both ways of connecting (`befriend`); removing a friend or blocking them takes it back from both (`unfriend`), and becoming friends again pays again |
| Checking in | 5 | At most 4 a day; nothing within 2 hours of a check-in at the same place that earned |
| Reporting occupancy | 3 | A new report only (not one that replaces yours), at most 10 a day |
| A 👍 on your report | 1 | Only reports sent signed in; taken back when the vote turns 👎 or goes |
| Rating someone's report | 1 | Once per report (changing or removing the vote earns nothing more), at most 20 a day |
| Sending an invite | 3 | `POST /api/cred/invite`, at most 5 a day |
| Reporting a problem | 5 | Feedback in `broken` or `wrong-info`, at most 3 a day |
| Sending feedback | 10 | Feedback in `idea` or `other`, at most 1 a day; reporting a person earns nothing |
| Rating a dish | 3 | Once per dish (a dish is one day's serving), at most 5 a day; rating it again earns nothing |

- **Data** (accounts database): `cred`, one row per award (`UNIQUE (user_id, action, ref)` makes it happen once; `detail`
  is the place's or dish's name for the log); `users.cred_total` (all-time, raised in the same batch, kept when old
  rows go) and `cred_at`, `board`/`board_at` (the leaderboards' opt-in), `likes_received`, `bg2`, `fg2`, `metal`;
  `report_owners` (which account sent a report in `fruum`, which itself never gets a user id), `report_votes`,
  `meal_ratings`. The daily clean-up drops `cred` rows after 12 months (except friends', which last as long as the
  friendship), report links and votes after 2 days, meal ratings after 60 (as long as the menus). Deleting an account
  deletes its rows; others keep what they earned through it, their rows no longer naming it ("a former user").
- **Levels** on all-time points: 1 from 0, then each step 50 more than the one before (100, 250, 450, 700, 1000, 1350
  … up to level 20 at 10,450, the top; `levelOf`, `levelStart`, `MAX_LEVEL` in `cred.ts` and `lib.js`). Unlocks: 2
  gradient background, 3 gradient text, 4 bronze, 5 silver, 6 gold; nothing new after that. At level 20 the bar is full
  ("Top level: 20") and `nextLevelAt` is null.
- **Bug reports** (`worker/bugs.ts`, `static/bugs.js`, accounts table `bug_reports`): "Report a bug" (+50) in the account
  menu lays a picker over the page ("Tap what's broken", Skip, Cancel), then opens the feedback window in its bug mode
  with the tapped element's description (`describeBugElement`: tag, id, tutorial name, label, the start of its text; no
  screenshot). `POST /api/feedback` with `bug: true` and category `broken`, signed in: stored as usual in `fruum`, linked
  to the account as pending (at most 3 waiting, else 409 `bugs_pending`), no instant points, the email's subject says
  "Bug report (reward pending) from @user". On `/admin` (`POST /api/admin/bug { id, decision, reason }`) an admin
  rewards it (`bug`, +50, once per report) or declines it with a reason of at most 120 characters, which the sender sees
  under "Your bug reports" on the Street cred page (`GET /api/cred` `bugs`). Decided ones go 90 days later, pending ones
  after 12 months. Signed out, `bug` is plain feedback.
- **Endpoints** (in `SOCIAL_PATHS`, signed in): `GET /api/cred` (`{ total, recent, level, levelStart, nextLevelAt,
  nextUnlock, board, likes, trusted, latest }`, recent = the last 30 days; `likes`: 👍 received on your reports), `GET /api/cred/log?day=YYYY-MM-DD&before=<id>` (50 a page,
  newest first, `more`, and on the first page `days` with entries), `PUT /api/cred/board { on }`, `GET
  /api/cred/board?range=recent|all&after=<rank>` (403 `not_on_board` unless you joined; everyone who joined, 50 a page
  after rank `after`, ties to whoever got there first, `more` when another page follows, and `you: { rank, points }`), `POST /api/cred/invite { kind }` (`checkin`, `place`, `meal`,
  `friend-link`). Log labels are built when read ("Checked in at HG E 41", "Friends with @raffi").
- **Answers that award** carry `cred: { points, total, level }` (`points` 0 when capped): `POST /api/checkin`,
  `POST /api/friends/requests` and `.../accept` when they make friends, `POST /api/cred/invite`, and, when signed in,
  `POST /api/report` and `POST /api/feedback` (which read the session optionally: `optionalUser` in `auth.ts`).
  `GET /api/me` has `cred: { total, level, trusted }` (the menu's badge, the toast's level-up).
- **The page** (`static/cred.js`): "frooms Street cred" after Friends in the account menu, with the level ("Lv 4"),
  opens the view "cred": the 5 latest entries ("Today 14:05", "Yesterday 18:30", "Mon 16 Nov"; `credWhen` in `lib.js`)
  and "Show more", which opens "cred:log" in the same sheet (Back returns): all entries 50 at a time, and a day filter
  (the date picker of `picker.js` with only the days that have entries, and "All days"). Then Recent (last 30 days) and
  All-time in big figures with your bubble and level, a bar to the next level ("180 to level 5"), the next unlock
  ("Level 5: silver bubble", or "More rewards later"), and the trusted reporter's progress ("12 of 20 👍 …"). "How to
  earn street cred" (folded) lists the table above. The leaderboards (Recent / All-time) need joining first ("Join the
  leaderboards", which says what others then see, or "Show me on the leaderboards" at the profile step, unticked by
  default, `board: true` in `POST /api/me/profile`); then rank, bubble, username, name and points, your row
  highlighted, in a box that shows 10 rows and scrolls, loading the next 50 as its end comes into view; your own row
  stays below the box until its page has loaded. "Leave the leaderboards" asks once.
- **The toast** (`showToast`, `credEarned`): every answer with `cred.points > 0` shows "+5 street cred" for 3 s above
  the tabs (at the bottom of the left column on wide windows), with "Level 3! Gradient text unlocked" on a level-up; it
  is a manual popover, so it shows over an open window too, and `role="status"`. Check-ins, friends, reports, votes,
  feedback, invites and meal ratings use it. "You're a trusted reporter now" shows once per browser and account when
  `/api/me` or `/api/cred` first says `trusted` (localStorage `frooms-trusted`).
- **Invites** (`inviteControl`'s `kind`): signed in, WhatsApp or a copied link also sends `POST /api/cred/invite`
  (`place` for rooms and spaces, `meal`, `checkin`, `friend-link`), after the invite itself and never in its way.
- **Bubbles** (the unlocks): Profile has, below the two colours, "Street cred unlocks" in level order: Gradient
  background (a second background colour, level 2), Gradient text (a second text colour, level 3) and the metals
  Bronze, Silver and Gold (levels 4 to 6, each a designed background and letter gradient, `BUBBLE_METALS` in
  `lib.js`). Locked ones are greyed with "Level N". A metal clears the gradients and a gradient or colour the metal.
  Every background stop must keep 3:1 against every text stop (`readableBubble`, and `readableStyle` in `social.ts`).
  `POST /api/me/profile` takes `bg2`, `fg2` and `metal` (left out: kept; null: cleared), answers 403 `locked` for a new
  style above your level and 400 `bad_style` for a metal with a gradient; a style stays when points are taken back
  below its level. `users` has `bg2`, `fg2` and `metal`; every person the Worker sends carries them, and `bubble()`
  (`account.js`) paints them everywhere a bubble shows (custom properties set through the CSSOM, letters clipped to a
  gradient by an inner span).
- **Privacy and About:** the privacy notice (`static/privacy.html`, both languages, 18 November 2026) has a section
  "Street cred, ratings and votes" saying what is kept, for how long and who sees it (the table above's data), and that
  points are counted per account only for your own view and the leaderboards. The About text (`<template id="about-text">`)
  has a "Street cred and ratings" section. **Releasing** needs `0002_cred.sql` applied to `fruum-accounts` first
  (`CLAUDE.md`).

### Report votes

👍 ("Accurate") and 👎 ("Not accurate") on each line of a place's Report log (`plans/PLAN_STREET_CRED.md`, section 9).
The log stays anonymous: no username, name or bubble, not even to friends, and nothing in the answer tells two reports
of one person apart. Only your own reports say "You", and only to you.

- **`POST /api/reports/vote { id, up }`** (in `SOCIAL_PATHS`, signed in): `up` true, false or null (removes the vote).
  404 `no_such_report` once the report is older than the 4-hour log (or it's a rating), 403 `own_report` on a report
  you sent signed in. Answers `{ report: { id, up, down, trusted, mine, vote }, cred }`; the page redraws that line.
  The voter earns 1 on the first vote on a report; the reporter (if they sent it signed in) 1 per 👍, taken back with
  the 👍, and `users.likes_received` moves with it.
- **`GET /api/reports`** reads `report_owners` and `report_votes` of the listed ids from the accounts database (one
  query, `reportMarks` in `cred.ts`): `up`, `down` and `trusted` for everyone where sign-in is on, `mine` and `vote`
  signed in. Signed-out answers are cached a minute (`public, max-age=60`), signed-in ones `private, no-store` (the page
  asks past the browser's cache when signed in). On a host without sign-in the entries have none of these.
- **Trusted reporters:** 20 👍 received in total (`likes_received`, kept with the account after the 2-day clean-up of
  the links) make every report you send signed in show the round frooms icon (`static/icons/trusted.svg`) and a faint
  tint, labelled "Trusted reporter", for everyone. Back below 20 (a 👍 turned 👎), the mark goes. `GET /api/cred` has
  `likes` and `trusted` for the Street cred view. The summaries and the map's figures count trusted reports the same.

### Meal ratings

Signed-in people rate a day's dish from −5 to 5 in steps of 0.5, in three optional categories: taste, portion size and
value for money (`plans/PLAN_STREET_CRED.md`, section 10; `worker/ratings.ts`, `static/ratings.js`). Each day's
serving starts without ratings: a dish is `facility|date|meal|line|name` (the name trimmed and lower-cased; `dishKey`
in `ratings.ts` and `lib.js`).

- **On the page:** at each dish's bottom right in the menu panel's day and week views, and in its lightbox (also from
  the comparison and Find your meal), the average Ø in a big figure (one decimal, "+" for positive), coloured from dark
  red (−5) through the neutral (navy in light, white in dark) to dark green (+5), mixed in OKLab (`ratingColour` in
  `lib.js`; the colours are `--rate-neg`, `--rate-zero`, `--rate-pos` in `style.css`, each at least 4.5:1 on the card),
  or a muted "–" without ratings. "Rate" beside it for today's and yesterday's dishes; earlier days show their average
  only, later days nothing. On phones the rating takes its own line under the dish's text. Fetched once per open panel
  and day (`GET /api/meal-ratings`), not part of the cached `/api/menu`. Where sign-in is off there are none.
- **The window** (`dialog#meal-rating`): the dish and the mensa, then Ø, a dashed line, Taste, Portion size, Value
  for money ("Portion", "Value" below 360 px), each a bar from a common 0 line (up and green, down and red, 5 = half the
  height) with its value above; "12 ratings", Close, and "Rate" (or "Change your rating") when the dish takes ratings.
  Rating, the bars are sliders: drag them (snapping to 0.5), or arrow keys ±0.5, Page Up/Down ±2, Home −5, End +5,
  Delete to unset; a click on the value above a bar types it. They start unset ("–", "Drag or type"), or with your
  earlier values; Ø follows; "Rate" sends once one is set. Signed out it asks to sign in.
- **`GET /api/meal-ratings?place=MMB79&date=2026-11-18`** (public): `{ place, date, dishes: { <key>: { avg, taste,
  portion, value, n, nTaste, nPortion, nValue, mine? } } }`, each category the mean of the ratings that set it, `avg`
  the mean of the category means present, rounded to 0.1; signed in also `mine` (your values, or null). Cached a minute
  signed out, `private, no-store` signed in. 404 `sign_in_off` on hosts without sign-in.
- **`PUT /api/meal-ratings { place, date, meal, line, name, taste?, portion?, value? }`** (signed in, through
  `handleSocial`): the dish must be on the stored menu of the place's facility that day (404 `no_such_dish`), the date
  today or yesterday in Zurich (400 `not_rateable`), each value −5 to 5 in steps of 0.5 and at least one set (400
  `bad_rating`). Rating again replaces yours (categories left out become unset). Answers `{ key, dish, cred }`.

### Usage counters

How often parts of frooms are used, as daily totals without any identifier (`plans/PLAN_ADMIN_STATS.md`,
`worker/stats.ts`, `migrations-accounts/0003_stats.sql`). A count is a metric's name, a Zurich day and a number: never a
user id, a browser id, an IP address, a search text or a place. The admin page (`/admin`, below) reads them.

- **Data** (accounts database, so the preview's counts stay in `fruum-accounts-dev`): `stats_days`, one row per Zurich
  day, `counts` a JSON object (`{"search": 12, "tab_eat": 4}`). Each beacon or counted action is one upsert
  (`bumpStatement`: `json_set` over allow-listed keys, the numbers bound). Kept indefinitely (about 365 rows a year).
- **Counted by the page** (`METRICS` in `stats.ts` with `by: "page"`, `STATS_KEYS` in `lib.js`; a test keeps them
  equal): `load`, `load_signed_in` (`/api/me` answered with an account), `tab_study`, `tab_meet`, `tab_eat`, `tab_you`
  (a tab button clicked, not the tab the page opens on), `search` (the place search, once typing has stopped for 1.5 s
  with at least 2 characters or a result is picked, each text once while search is open), `search_pick` (a place,
  person or "Go to" result opened), `meal_search` (Find your meal opened), `people_search` (a `/api/people` call sent),
  `place_open` (a room's or space's view opened, not by Back), `menu_open` (a mensa's menu panel, also from Find your
  meal), `invite` (an invite's WhatsApp or Copy link), `install` (opened as an installed app, once a day per browser),
  `tutorial_open` (the tutorial started, not again on the way back from signing in) and `tutorial_start_<journey>` and `tutorial_done_<journey>` for `friends`,
  `study`, `meet`, `food` and `map` (a journey started, its closing card reached). While the tutorial runs only its own
  counters count (the tabs and places it opens aren't the person's use).
  `countUse(key)` in `app.js` adds to `frooms.stats` in local storage (in memory when storage fails; `addStat`,
  `cleanStats` and `statsBody` in `lib.js` cap each at 50). When the page is hidden (`visibilitychange`, `pagehide`),
  at most once a minute, `navigator.sendBeacon` sends it and the stored counts are cleared. Nothing is sent while the
  page is visible; the service worker never touches it (POST).
- **Counted by the Worker**, in the same `db.batch` as the event's own writes (`batchWithBump`): `sign_in` and
  `account_created` (`/auth/callback`; a new account told by looking the id up first), `account_deleted`
  (`DELETE /api/me`), `account_expired` (the daily clean-up, by the number removed), `friend_request` (a new request
  only, not asking again or answering one), `checkin`, `report_vote` (a new vote, not a change or removal),
  `meal_rating` (a new rating, not rating again).
- **While `stats_days` is missing** (frooms.ch until `0003_stats.sql` is applied there) nothing is counted and nothing
  else breaks: a batch that fails on "no such table: stats_days" (D1 rolls the whole batch back) is sent again without
  the bump; the beacon answers 204. Logged once per isolate.
- **`POST /api/stats`** (the beacon): `{"c": {"search": 3, "tab_eat": 1}}` as `text/plain`, at most 2 KB. Page keys
  only, each a whole number from 1 to 50; unknown keys are dropped, the Worker's own keys refused, anything else 400.
  Only on hosts with an accounts database (frooms.ch, the accounts preview); elsewhere 204 and nothing written. No
  sign-in, the session cookie isn't read; another site's `Origin` gets 403. `STATS_LIMITER` (10 a minute per IP):
  over it 204 and nothing written. Counted on the Worker's Zurich day. Answers 204, `no-store`.
- **Locally:** `npx wrangler dev` over plain http has no accounts database, so the beacon writes nothing. With
  `--local-protocol https` and dummy `EDUID_CLIENT_SECRET` and `SESSION_KEY` in `.dev.vars`, the Worker sees
  `https://frooms.ch` and counts into the local `fruum-accounts` (apply `migrations-accounts` to it with
  `npx wrangler d1 migrations apply fruum-accounts --local`); `scripts/page_check.mjs` then needs the full
  `https://127.0.0.1:8787/` URL and a Chrome started with `--ignore-certificate-errors` (`--chrome <wrapper script>`).

### The admin page

`https://frooms.ch/admin` (`static/admin.html`, `admin.js`, `admin.css`; `worker/admin.ts`): usage numbers for the
accounts whose edu-ID id is in the Worker secret `ADMIN_IDS` (comma-separated `users.id`; empty or unset: nobody). Not
linked from anywhere, `noindex` (meta tag and `X-Robots-Tag` in `_headers`), and the service worker leaves `/admin`
alone (never cached, never answered with the app shell).

- **`GET /api/admin/stats`**: signed in, profile done, id in `ADMIN_IDS`; anyone else (signed out, not an admin, a host
  without sign-in, another method) gets the same 404 as an unknown `/api` path. `ACCOUNT_LIMITER` counts the admin's
  calls. `Cache-Control: private, no-store`. Answers `{ day, host_db, generated_at, groups, visits, counters, feedback }` (`feedback`: the newest 100 messages of
  fruum's `feedback` in full, newest first, with category, time, email and context; the page lists them under the numbers,
  20 at first; the email per feedback is unchanged): per
  group (Accounts, Social, Contributions, Use) its metrics, each with `label`, `source`, `note?`, `total`, `d30`, `d7`,
  `today` (null: no value for that period), `series?` (30 numbers, one per Zurich day, oldest first), `since?` (a
  counter's first day) and `parts?` (each university, each way an account goes, the meal ratings kept now).
  `counters` is `"missing"` while `stats_days` doesn't exist (the counted numbers are then null). `visits` is a group
  like the others ("Visits (UTC days)": visits and page views, no total, its own `day`, a UTC date) or null with
  `visits_reason` (`no_token`, `no_site`, `timeout`, `error`).
- **Visits** come from Cloudflare Web Analytics through Cloudflare's GraphQL API (`https://api.cloudflare.com/client/v4/graphql`,
  `rumPageloadEventsAdaptiveGroups`: `sum { visits }` and `count` per `date`, the last 30 UTC days, filtered by
  `accountTag` and `siteTag`) with the read-only token in the secret `CF_ANALYTICS_TOKEN` and the vars `CF_ACCOUNT_ID`
  and `CF_SITE_TAG` (`wrangler.jsonc`; the site tag from the Web Analytics dashboard's URL, `siteTag~in=…`, not the beacon's token). Cloudflare's days
  are UTC days, so the card says so and its charts end on the UTC day. A good answer is cached 10 minutes (Cache API,
  one fixed key); without the token, on an error or after 3 s the card shows "Visits: see Cloudflare Web Analytics"
  with a link to the dashboard, and the rest of the page is unaffected.
- **Periods** are Zurich calendar days (`worker/tz.ts`, so a DST day is 23 or 25 hours): today since midnight, 7 days
  (today and the 6 before), 30 days (today and the 29 before), total (everything there is).
- **Sources:** the tables where their history is complete (`users`, `friends` once per pair, `checkins`, `stars`,
  `meal_ratings`, `cred`; in `fruum`, `reports` and `feedback`), the counters where it isn't (sign-ins, accounts made
  and deleted, friend requests, report votes, meal ratings, the page's use). On the accounts preview the accounts are
  `fruum-accounts-dev`'s but reports and feedback are production's, and the page says so.
- **Reads:** one batch per database; each day bucket is a `CASE` over the 30 day starts in SQL, so every table is
  scanned once (users and reports twice). See `plans/ADMIN_STATS_DECISIONS.md` for the rows read per view.
- **The page:** one card per group, a table (Total, 30 days, 7 days, Today; "–" where a period has no value, "since"
  under a counter's total) with a 30-day bar chart per row (today's bar dark; each bar's day and number on hover, all of
  them in the chart's label). "Use" is sorted by its 30-day numbers. Two columns from 1100 px; on phones the chart moves
  under the numbers. Signed out it offers "Sign in" (`/auth/login?return=/admin`); not an admin: "Not available."
- **Locally:** `node scripts/page_check.mjs --account admin /admin` (a full answer with visits), `admin-novisits`
  (counters not set up, no visits), `active` (not an admin) or `anon` (signed out). Against the Worker itself: as for
  the counters (`--local-protocol https`, `.dev.vars` with dummy secrets and `ADMIN_IDS=<a test id>`), with a `users`
  and a `sessions` row made by hand in the local `fruum-accounts` and the session's token as the
  `__Host-frooms_session` cookie (`curl -k`).

### Tutorial

A guided tour over the real page (`plans/PLAN_TUTORIAL.md`, `static/tutorial.js`), started from the account menu
("Tutorial"), the You tab's footer, the sign-in view ("New to frooms? Take the tour"), the first-visit window or the
address: `/?tutorial` (the welcome screen), `/?tutorial=friends|study|meet|food|map` (that journey), `&step=<n>` (resume
there, the way back from signing in); the parameters are taken out of the address once read (`parseTourParam` in
`lib.js`). `tutorial.js` is loaded only then (`tourLoad` in `app.js`) and is in the service worker's shell.

- **The welcome screen** asks "What are you looking for?" with six journeys (✓ on those finished): Connect with my
  friends on campus, Find places to study, Find a room to meet with my team, Look through food options, Navigate the
  campus, Earn street cred
  (`tourJourney` in `tutorial.js`: the shared chapters below plus each journey's own steps). Friends: A, G, then the
  account menu's Friends, finding people, the add-a-friend link, Check in and its places, the friends' bubbles on the
  map, "Friends here now" in You, Invite and Street cred. Study: A, the Study tab, its map filter, the locate button,
  the first space, D, E, Study's rooms, B, F. Meet: A, the Meet tab, C (tomorrow at 14:00), room types and equipment,
  the rows' day bars, D, E, Invite and its menu, B, F. Food: A, the Eat tab, a mensa card, D, Compare menus, a dish's
  window and its ratings, Find your meal and its presets, the microwaves, B, F. Map: A, moving and zooming the map,
  picking a building, the whole-campus button, the other campuses' buttons, the map's filters and folding them, and
  friends on the map (an example bubble when none shows). Street cred: G, then the account menu's Street cred, your
  level, and every action that earns it where it happens (adding friends +25, checking in +5, reporting how full +3,
  rating reports and 👍 received +1, inviting +3, reporting a problem +5, rating a dish +3, feedback +10), ending on
  "How to earn street cred". D's "What you can do" goes through the action rows one by
  one. The closing card has "Back to the
  start" and "Done"; Study, Meet, Food and Map add a tip and "Show me" (the friends journey, until it's done).
- **Signed out, the friends journey** offers "Sign in with edu-ID" (the address becomes
  `/?tutorial=friends&step=<next>`, then SWITCH; back on the page the journey goes on there, counted once) or
  "Continue without": the steps that need an account explain in a card without a hole, and the closing card offers
  the sign-in again. A new account first gets its welcome view without the fog; the tour comes back once the
  username is saved. A failed sign-in shows its usual text on a card, then the journey goes on without an account.
  Where sign-in is off (locally, other previews) the account steps explain too.
- **The About text** starts with a line pointing to it ("New here? The tutorial walks you through frooms"); its link
  starts the tour on the page.
- **The first-visit window** ("New to frooms.?", `<dialog id="tour-offer">`, `showTourOffer` in `app.js`) opens in the
  middle of the screen on a plain first load in a browser: `/` without a query (not an invite, a place's address,
  `?add=`, `?edit`, `?pins`) and no stored choices (`tourOfferShown` in `lib.js`). "Take the tour" (left) opens the
  tutorial's welcome screen. "Skip" (right, the main button, focused; also Escape or a click beside the window) opens
  the account menu with the tutorial's fog around it, the blue ring on Tutorial and a tag "Find it here any time"
  beside it (`tourOfferPoint`, drawn in `app.js` without loading `tutorial.js`); the next click or key anywhere closes
  all of it. Either way, or the tour started elsewhere, sets `seenOffer` in `frooms.tour`, and it doesn't show again.

- **The fog:** `#tour`, a manual popover in the top layer: a light full-window SVG path (`--tour-fog` light and dark,
  `fill-rule: evenodd`) with a rounded hole on the step's target and its `context` (the account menu, the action grid,
  the map's visible part), a 1.5 px blur clipped to the same path, a blue ring (`--tour-ring`) around the target, and
  the step's card beside the hole (beside the ring when the context is too big). Clicks go through the ring to the real
  element; a clear path over everything else takes them, the context included. A target or context may be several
  elements (an action row) or a box (the map). The friends steps show an example bubble when no real one shows; it is
  drawn by the tour only. The hole follows its
  element every frame (a dragged sheet, a scrolled list). While a modal dialog is open, `#tour` moves into it, since a
  modal dialog makes everything outside it inert, popovers above it too.
- **Steps** are plain objects (`id`, `title`, `body`, `target`, `advance` "next" or "tap", `before`, `ready`, `fallback`,
  `only`, `actions`, `signedIn` with its `explain`, `keepMenus`); journeys list chapter ids and their own steps, laid out by `tourPlan` (`lib.js`). The progress (`frooms.tour` in local storage, `cleanTour`)
  holds the chapters and journeys done.
- **Keyboard and screen readers:** the card is a `role="dialog"` named by its title and described by its body; it takes
  the focus at each step (the skip prompt and choices: their main button), and a polite live region says where you are
  ("Food · 3 of 22"). Tab stays between the card's buttons and the spotlit element, so a "tap" step works with Tab and
  Enter (the hint "Click it" adds "Tab moves to it." for screen readers). Escape asks once ("Exit the tutorial?"), a
  second Escape exits; it never closes a window the step opened under it. At the end the focus goes back to what
  started the tour (the account button when that was the account menu). With `prefers-reduced-motion` the hole jumps,
  the card doesn't slide or shake, and the search's example is typed at once. On short windows (a laptop at 200 % zoom
  is 720 × 450) the card is smaller and scrolls rather than running off; when it can't miss the hole, it covers the
  least of it.
- **Targets** are found by name, never by layout: `data-tour="<name>"` on the real elements, set where the page draws
  them (`index.html` for the fixed ones, `markTour` in the scripts; the plan's section 8 lists them, plus `sheet`,
  `search-view`, `search-back`, `report-choices`, `friends-search`, `friend-link`, `checkin-place` (the Check in
  view's first place), `invite-menu` and `dish-box` (a dish's window)). A list marks its first suitable row while drawing it
  (`markFirstRow`): `first-space` (the first open library or study space), `first-study-room`, `first-room` (the first
  room free long enough in Meet) and `first-mensa` (the first serving now, else opening later today; `tourFirstMensa`).
  A target drawn again (the list refreshed) is looked up again, and one outside the visible part of its list is
  scrolled into view.
- **Chapters** (`tourChapters` in `tutorial.js`): A map and sheet, B search, C time and filters, D place details, E
  occupancy reports, F stars and You, G account, each with the places of the journey it runs in (D opens a study
  space, a room or a mensa). A step that doesn't apply (the sheet's handle on a wide window, a space without a
  sensor) is passed. A seen chapter is left out (A) or offered: "You've seen Place details already." with Skip and
  Show again.
- **Checking a chapter on its own** (a debug address): `/?tutorial=chapter:D` runs chapter D with the study journey's
  places, `/?tutorial=chapter:D:meet` with a room, `/?tutorial=chapter:B,D,F:food` several in a row. One chapter always
  shows; several skip the seen ones as a journey does. Nothing is counted.
- **Nothing is sent** while it runs (`tourActive()` in `app.js`): reports, feedback, invites (WhatsApp, Copy link) and
  every account call except `GET` and `PUT /api/me/stars` fail with "In the tutorial nothing is sent." in place of their
  confirmation. Stars stay allowed.
- **Exit** puts the page back as it was: tab, location, time, buildings, room types, equipment, map filter, the open
  place and the sheet's position (account views aren't brought back); the menu panel, a dish's window, the account
  menu and invite menus the tour opened are closed.

## Local app (FastAPI)

### Setup

Requires Python 3.11+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Run

```bash
export FROOMS_CONTACT=you@example.com   # optional: contact address sent to ETH in the User-Agent
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000, pick one or more buildings, and the list fills in.
To preselect buildings via a bookmark, use http://127.0.0.1:8000/?buildings=HG,CAB.

- **Free now**: "free until 16:00", "free until closing (20:00)" or "free rest of day". Gaps under 20 minutes are greyed out.
- **Free soon**: busy, but free within 30 minutes.
- **Busy** and **No data** are collapsed. "No data" means ETH returned nothing for that room, which usually means it isn't managed in the booking system.
- Tap a row to see the current or next booking. Tap the room name to open ETH's allocation page for that week.
- With "Now" selected, the page refreshes every 5 minutes.

Defaults are lecture halls (3430) and seminar rooms (3420). Meeting rooms and others can be turned on under *Filters*.

## Tests

```bash
pytest
npm test
```

The tests use fixed samples in `data/samples/` (week of 26.10.–01.11.2026). Don't re-download them.

## API

| Endpoint | Description |
|---|---|
| `GET /api/buildings?types=3430,3420` | Zentrum buildings with room counts |
| `GET /api/types` | Meet's room types (meeting room, seminar room, lecture hall: `MEET_TYPECODES`) with counts, plus the default typecodes (seminar room, lecture hall) |
| `GET /api/dates` | Earliest and latest date visitors can pick: a month back (the history) to 4 months ahead, within ETH's range |
| `GET /api/free?buildings=HG,CAB&at=2026-10-29T14:00&types=3430&min_seats=20` | Status per room, sorted with free rooms first |
| `GET /api/spaces?area=Z&at=2026-11-02T10:00` | Study spaces and mensas of an area: open or closed, until when, and ETH's occupancy estimate (now only). On ETH Zentrum and UZH Zentrum, also the other campus's mensas (`partner: true`). Each space has `reports` (now only) and `usual`, each mensa with a menu `flagship` (the card's dish for the current or next meal: `line`, `name`, `price` by group, `image` while `/api/meal-image` serves it; `null` without dishes); the answer has the location's `microwaves` and its mensa `order` (as `/api/menus`). A mensa missing from ETH's list is still there, as a place with menus only. Worker only |
| `GET /api/map?area=Z&at=2026-11-02T10:00&min_free=60` | `order`, the location's mensas in our order (the place labels' priority), and per building: open study spaces and the suggested one, lecture halls and seminar rooms free for at least `min_free` minutes (30 to 240, default 120; field `rooms.free`) and the ones free longest. With `&building=HG` also `detail`: each of its rooms, study spaces and places with its level (floor view). With `&rooms=1` also `rooms`: the area's rooms of `types` (default 3420, 3430; Study asks for 3650, 3420, 3430, Meet for its picked types) with at least `min_seats` seats, as `/api/free` entries in its order, each with `equipment`, `blocks` and `reports`, from D1 only (`null` outside the stored range); `&equip=screen` leaves out rooms known to have no screen or projector. One D1 read serves both. Worker only |
| `GET /api/room?room=HG+E+33.1&area=Z&at=…` | One room: its `/api/free` entry (with `equipment`, `blocks` and `reports`) and its `bookings` on that day (`from`, `to`, `kind` booking or closed, `title`; UZH's titles are always null). Same rules and rate limit as `/api/free`; 404 for an unknown room. Worker only |
| `GET /api/menu?place=MMB79&from=2026-11-16&days=7` | One place's menus from `from` (default today) for `days` days (1 to 21): each day's meals with their dishes (full meals only: CHF 5 and up, or without a price; line, name, type, price by group, allergens, `nutrition` per 100 g, UZH's `climate` rating, `image`), and the week's meal times (`slots`). Cached 10 minutes. Worker only |
| `GET /api/menus?area=Z&date=2026-11-16` | Every place of the location (both Zentrum campuses together) with its menu on one day (`day`, or `null`; full meals only, as `/api/menu`), for the comparison, Find your meal and "Your meal" on the cards, and the location's mensa `order`. Cached 10 minutes. Worker only |
| `GET /api/meal-image/<id>` | A dish photo, only for today's and tomorrow's dishes (else 404), resized by Cloudflare Images. Worker only |
| `POST /api/report` | An occupancy report about now (see "Reports, equipment and usual occupancy"); answers `{ ok, stored, summary }`, and `cred` when signed in (Street cred). Worker only |
| `DELETE /api/report` | Removes the browser's own report of a place and kind, with the street cred it earned; answers `{ ok, removed, summary }`. Worker only |
| `GET /api/reports?place_kind=space&place=HGH30.1` | One place's reports of the past 4 hours and its 2-hour summary, with 👍 and 👎 counts and the trusted mark where sign-in is on. Worker only |
| `POST /api/reports/vote` | 👍, 👎 or no vote on a report of the past 4 hours, signed in (see "Report votes"). Worker only |
| `POST /api/stats` | The page's usage counts since its last beacon, as daily totals without any identifier (see "Usage counters"); answers 204. Worker only |
| `GET /api/admin/stats` | The admin page's numbers, for the ids in `ADMIN_IDS` only; 404 for everyone else (see "The admin page"). Worker only |
| `GET /api/meal-ratings?place=MMB79&date=2026-11-18` | The ratings of a place's dishes on a date, by dish key, where sign-in is on (see "Meal ratings"). Worker only |
| `PUT /api/meal-ratings` | Your rating of today's or yesterday's dish, signed in (see "Meal ratings"). Worker only |
| `DELETE /api/meal-ratings` | Removes your rating of a dish (the ✕ in its ratings window) with its 3 street cred, signed in. Worker only |
| `GET /api/index` | What search looks through, all five locations in one answer (cached an hour): `rooms` as `[path, area, typecode, seats]`, `spaces` (study spaces, libraries, mensas, cafeterias) as `[id, area, name, room, category or kind]`, `buildings` as `[code, area]`. Worker only |
| `GET /api/areas` | The locations (ETH's and UZH's), each with its `university`. Worker only |

In the Worker, `/api/free`, `/api/room`, `/api/buildings`, `/api/types`, `/api/spaces`, `/api/map` and `/api/menus` take `area=UZ`, `UI` or `UO` for UZH, and `/api/menu` takes a UZH mensa's id (`place=UM1`).

## How the data is interpreted

| `belegungstyp` | Meaning | Treated as |
|---|---|---|
| 2 | Booking (lecture, meeting, exam …) | busy |
| 5 | Blocked / renovation ("Umbau") | busy |
| 8 | Building closed (no event) | closed |
| 11 | Lecture | busy |
| 13 | Cancelled lecture (`findetStatt: 0`) | free |
| other | Unknown, logged as a warning | busy |

Any entry with `findetStatt: 0` is treated as cancelled. Times are local Zurich time, and `23:59` means midnight. Touching blocks are merged, so a lecture running straight into closing time counts as one busy stretch, while the UI still names the event currently running. Closing times come from the data and differ by building: HG is open until 22:00 on weekdays and 08–17 at weekends; most others close at 20:00.

## Caching and politeness

- Catalogue: fetched on startup and cached on disk (`data/cache/`) for 24 h. Falls back to `data/rooms_snapshot.json` if ETH is unreachable.
- Allocations: one request per room (ETH has no bulk endpoint), covering the chosen day and the next. Cached in memory for 10 minutes. At most 4 concurrent requests, with one retry.
- Only rooms in the selected buildings and types are fetched.

## Scripts

- `scripts/fetch_samples.sh`: refresh the catalogue snapshot (`--samples` also re-downloads test samples; avoid this). `--cookpit` refetches only the three Cookpit rotas (with nutrition); the menu tests pin their week, so move those dates after it.
- `scripts/seed_local.ts` and `scripts/page_check.mjs`: local data and screenshots (see "Working locally").
- `scripts/explore_catalogue.py`: rooms per building and type counts in Zentrum.
- `scripts/try_client.py`: print today's allocations for a few HG rooms.
- `scripts/survey.py [from] [to]`: one week across all seated Zentrum rooms, with type, cancellation and empty-response statistics. About 175 requests, so run it sparingly.
- `scripts/freshness.py`: the first run of the day saves a snapshot; later runs show what changed.
- `scripts/golden.py`: regenerate `test/golden/` after changing the Python logic, then make the TypeScript port match.
- `scripts/make_icons.sh`: render the PWA icons with headless Chrome.
- `scripts/make_map.py`: build the map view's campus files, region tiles and overview from OpenStreetMap (see Map view).
- `scripts/make_floors.py HG`: build a building's floor plans from ETH's plan PDFs (see Map view, "Building floor plans").
- `scripts/make_mensa_photos.py`: make the Eat tab's mensa photos from `assets/mensa-photos/` (see The page, "Mensa photos").
- `scripts/uzh_catalogue.py`: refresh UZH's room and library snapshots (see UZH).

Run scripts from the project root with `python -m scripts.<name>`.

## Credits

- Wordmark font: [Archivo](https://github.com/Omnibus-Type/Archivo) by the Archivo Project Authors, SIL Open Font License 1.1 (`static/fonts/Archivo-OFL.txt`). It's self-hosted, so no requests go to Google Fonts.
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL; credited on the map.
- Room data: ETH Zürich's public room-info API, and UZH's public room calendar and University Library pages. This is an unofficial personal project, not affiliated with ETH Zürich or the University of Zurich.
