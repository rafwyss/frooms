# Choices

Product decisions that leave something out or show it differently from ETH's own pages, and why. When one changes,
update this list and the place it points to.

## Locations

- **ETH Zentrum and ETH Hönggerberg, and UZH Zentrum, UZH Irchel and UZH Oerlikon.** ETH's other locations (Basel,
  Lindau-Eschikon, Oerlikon, Schwerzenbach) added complexity (more locations, more prefetching) for very few users.
  Their rooms, study spaces, occupancy readings and menus are neither fetched nor stored: `AREAS` and `CAMPUS_AREAS`
  in `worker/config.ts` filter ETH's room catalogue and study-space feed before they are stored, and the occupancy
  readings by the stored spaces. Rows already stored for other locations age out with the history (`HISTORY_DAYS`);
  the occupancy history keeps what it has. ETH's rooms in UZH buildings (its area U) stay out too; UZH's own data
  covers those campuses.
- **UZH: only the centrally managed teaching rooms**, the ones in UZH's booking calendar (3V-Rooms), not institutes'
  own rooms. Event spaces counted in people (Lichthof, Mall, Medizinerhof), apéro areas, rooms without a room code and
  combined rooms whose parts are listed too are left out (`worker/uzh.ts` parseUzhCatalogue, `data/uzh.json`
  `exclude`). From 100 seats a room counts as a lecture hall, else as a seminar room; UZH doesn't say.
- **UZH bookings have no titles.** UZH's calendar only says "belegt", and its comments hold names and emails, so they
  are never stored or shown: a UZH room is just "booked".
- **UZH rooms only for the coming month.** They are never fetched on demand (each request needs a logged-in session),
  so later days show "no data".
- **UZH libraries: the University Library's locations on the three campuses** with seats and published hours. Those
  elsewhere (the UB's 'Übrige': Plant Sciences, Theology, Ethics, the Ethnological Museum) are left out like ETH's other
  locations, and so are locations without any hours (we couldn't tell when they're open). UZH's open study areas
  (foyers, hallways) aren't listed: UZH publishes no seats or hours for them.
- **UZH's mensas from ZFV's food2050 pages, not its API.** ZFV's GraphQL API (`api.zfv.ch`) needs a key we don't have
  (an open-source app's key is in its public code, but it was issued to them), so we read the public pages UZH's mensa
  site links to. They are made for browsers, so their format can change without notice; a page that can't be read keeps
  the stored menus. Switch to the API if ZFV gives us a key.
- **UZH: the mensas with menus on food2050** (`data/uzh.json` `mensas`; Tierspital's cafeteria at TFA added 17 November
  2026, and Atrium Irchel in Y05, which has food2050 pages but hasn't published a dish in weeks 44 to 48, so it shows as
  closed until it does). Left out: Lichthof (closed for building work), Forum (no menus there). Opening hours are the
  regular semester hours from zfv.ch, kept by hand; a day without a published menu counts as closed.
- **UZH's cafés without menus: only The Yard (Y13) and Irchel Bar (Y00)** (`data/uzh.json` `cafes`, Raffaele, 17
  November 2026), listed with the cafeterias and bars, open Monday to Friday by their zfv.ch hours (no holidays or
  closures known: Irchel Bar's summer break isn't in).
- **UZH's dish types:** food2050 marks vegan and vegetarian dishes, fish we take from the allergens, and a dish that is
  neither counts as meat when its name (or its description, unless the name says it's a vegetable dish) names a meat
  (Poulet, Rind, Schwein, Speck, Wurst, …; Raffaele, 17 November 2026); with meat and fish it's meat, as ETH's. The
  rest is "other" ("Pasta: vegetarian or with meat").
- **UZH's dish photos** come from each dish's food2050 page (read for its prices anyway); today's and tomorrow's dishes
  without one are read again every 6 hours, since photos come late. Served like ETH's (`/api/meal-image`, today's and
  tomorrow's only, resized).
- **ETH Zentrum and UZH Zentrum share their mensas.** The campuses are next to each other, so the Mensas tab, the menu
  comparison and the map's mensa layer of either show both universities' mensas (the other's say whose they are). The
  Study tab doesn't: Poly and Clausiusbar are listed as study spaces on ETH Zentrum only.
- **UZH buildings drawn together:** KOH is part of KOL's outline in OpenStreetMap (one connected main building), PLR
  of PLM's; their rooms and libraries count there on the map (`data/uzh.json` `map_buildings`), and with KOL picked the
  Meet list shows KOH's rooms too, as a section of their own (there's no other way to pick KOH). KO2 is in the same
  outline, but cut off it as a building of its own (`splits` in `data/map/campuses.json`, Raffaele, 17 November 2026),
  so its rooms can be reached from the map.
  Y03, Y04 and Y16 have no outline in OpenStreetMap: rather than draw outlines we'd have to make up, they get a label
  only, placed by hand (`static/map/pins.json`), with nothing to highlight. Without a pin they're left off the map,
  but listed.

- **The map's buildings are one frooms blue** for both universities (Raffaele, 17 November 2026, from the colour options
  built on ETH's and UZH's corporate colours): a calm blue-grey, the selected building a navy gradient. The label says
  whose a building is; the universities' own blues stay on what is theirs (the mensa tiles). The food colour stays amber.

## Mensas and cafeterias

- **Mensas and cafeterias are told apart by us, not by ETH**, in `data/overrides.json` (`eateries`, field `kind`).
  Mensas: Mensa Polyterrasse, Clausiusbar, Archimedes, food&lab, Polysnack, Tannenbar, Dozentenfoyer, Alumni
  quattro, food market, FUSION meal, Mendokoro and Rice Up!, and all of UZH's (`data/uzh.json` `mensas`). Every other place is a cafeteria, even if it publishes a
  menu (Bellavista). Only mensas have a menu and appear in the menu comparison. The Eat tab lists
  them in two groups, Mensas strictly above Cafeterias & bars, each with its closed places at the end; starred ones
  of both kinds come first in "Your mensas".
- **Eat has no building filter.** A location has about a dozen places to eat, and the question is "what is there and
  how far", not "what is in this building": the list is the whole location, nearest first once the position is
  known. A building picked earlier stays in the preferences, unused.
- **A mensa's card shows one dish, its flagship line's** (`flagship` in `data/overrides.json`: Street, Wok Street, The
  Expert, and for the others the line that was dearest in the week of 9 November 2026; UZH's mensas and mensas without
  one show the meal's most expensive dish). It's the dish people go there for, and its photo makes the card.
- **Find your meal ranks dishes, not mensas**, per 100 g for protein and carbs (the only basis both sources give; portion
  sizes aren't published). Every sort breaks its ties by the nearer mensa. Dishes without the value are still listed,
  apart, under "No nutrition data", so a mensa that publishes none doesn't vanish. Gluten-free and lactose-free go by
  the allergen lists and say so; a dish without a list passes.
- **One food preference at a time**, starred on a preset. It's a preset, not a place, so it has its own group in the
  You tab between the places to study and the places to eat, and it changes each card's dish to "Your meal". A mensa
  with nothing for the preference keeps its flagship dish rather than an empty line.
- **Our order of the mensas, not the alphabet** (`mensa_order` in `data/overrides.json`, Raffaele's): in Zentrum
  Mensa Polyterrasse, Obere Mensa, Untere Mensa, Clausiusbar, Archimedes, Platte 14, food&lab, Rämi 59, Polysnack,
  Tannenbar, Insieme, Dozentenfoyer; on Hönggerberg food market and FUSION meal, then the rest by name. Without a
  position the Eat list follows it (open ones first, then the closed ones in the same order), and so do the
  comparison's chips. With a position, nearest first wins.
- **The comparison starts with two mensas, or your stars.** Until you pick, it shows your starred mensas of the
  location; with one star, it and Mensa Polyterrasse (the Obere Mensa if the star is Polyterrasse); without stars
  Mensa Polyterrasse and the Obere Mensa (Hönggerberg: food market and FUSION meal). A dozen columns at once was too
  many to read. The chips are starred first, then nearest, else in our order (`compareOrder`), on one line that
  scrolls sideways so the table starts high. What you pick is kept per location.
- **Only full meals are listed: CHF 5 and up** (`MIN_MEAL_PRICE` in `worker/config.ts`). Salads by the 100 g, a
  piece of fish without sides and the like aren't a meal, and they made "cheapest" mean a side dish. A dish counts by
  its lowest price (students', staff's or everyone's); a dish without any price stays. It applies to every menu, the
  comparison, Find your meal, "Your meal" and the cards.
- **Cards have no Menu button.** A click opens the mensa's view, which has it; "Compare menus" at the top is one click
  from every menu.
- **Microwaves are listed in Eat, by building**, for both Zentrum campuses together, from a list kept by hand
  (`data/microwaves.json`). On the map each entry is its own marker where it is, once zoomed in far enough that a
  building's markers don't pile up; before that, one label per building with the total. The markers are never hidden by
  labels (they move just beside one they'd cover), since they're small and what you came for under the mensa filter.
  Corridor (MM C) and VSETH (CAB) have provisional spots until checked.
- **Tannenbar is a mensa all day**, listed under Mensas even outside its meal times (Raffaele, 15 November 2026). An
  ETH place can still be a mensa in its meal times and a cafeteria the rest of the day (`cafe_outside_meals` in
  `data/overrides.json`): outside its meal times it's then listed and mapped with the cafeterias and bars, in brown, and
  keeps its menu.
- **UZH's mensas are study spaces when open and not serving** (all of them, Seerose and Insieme too; Raffaele,
  17 November 2026): blue on the map, "Study space now" on their card, and listed in the Study tab then, like ETH's
  mensas that are study spaces. UZH has no `cafe_outside_meals`.
- **Mensa Polyterrasse stays when ETH's study-space list loses it.** In November 2026 it went missing from ETH's
  live list; it's then listed as a place with menus only (its hours from Cookpit, no study-space status), under the
  same id, so stars and links keep working.
- **Poly is Mensa Polyterrasse on the map.** The building's label shows the mensa's state, and the mensa has no label
  of its own (`place` for MM in `data/overrides.json`); the list keeps the name Mensa Polyterrasse. Einstein &
  Zweistein and bQm in the same building get their own labels.
- **Octavo (OCT) is left out.** OpenStreetMap has no building tagged "ETH OCT", so it can't be put on the map, and a
  place that's only in the list would be the odd one out. `hidden` in `data/overrides.json`.
- **Kiosk CLA is part of Clausiusbar.** It's the same counter area; it isn't listed or fetched on its own
  (`merge_into` in `data/overrides.json`).

## Statuses

- **Amber only while serving food.** A mensa is amber during its meal times; between them a mensa that is also a
  study space is navy ("Study space until lunch at 11:15", or "Study space until 19:30" before it closes), a
  cafeteria or bar brown ("Open until 18:30", even if it's a study space too, like Einstein & Zweistein), and a mensa
  that isn't a study space plain ("Lunch from 11:15"). The map follows the same rule, so
  a building like the Poly isn't amber all evening because a café in it is open.
- **In the Eat tab a mensa speaks of its meals only:** "Lunch until 13:30" (amber) while serving, "Lunch at 11:15"
  (plain) before today's next meal, "Open until 21:00" (plain) after the last one while it's still open, "Lunch
  tomorrow at 11:15" or "Lunch on Mon at 11:00" (grey) when the next meal is another day, "Closed today" (grey)
  when none is known. No "study space" status there: the mensa's view adds "Study space now, until 11:15" as a second
  line. Study and the You tab keep the wording above; cafeterias keep "Open until 18:30".
- **Green is only for free rooms** (seminar rooms and lecture halls); "free soon" is a muted green, as in almost free.
- **frooms' occupancy estimate is navy, people's reports are coloured.** The sensor's bar used to be a traffic light;
  now it's five navy steps, whatever the level, and the mannequins beside it (one grey without reports, one green
  free, two orange crowded, three red full) are what people reported, so the two are told apart at a glance. The map's
  occupancy dots keep ETH's traffic light. Reports show only for now (the You tab is always now); a closed space and a
  room without data show no mannequins.
- **The schedule bar shows 07:00 to 22:00**, not the whole day: before and after nothing is bookable that matters, and
  the strip stays readable on a phone. Bookings red, closures grey, free green; the needle at the chosen time. Where a
  booking and a closure overlap, the closure is drawn on top.

## Stars

- **Stars stay in the browser, and follow the account.** Signed out, starred places are stored with the other choices
  in `localStorage`, so they don't follow you to another device, and clearing the browser's data clears them. Signed
  in (accounts, `plans/PLAN_ACCOUNTS.md` 7.4), the account's list counts: the first load after a sign-in in a browser
  merges the browser's stars into it, and every change is sent along. At most 40, buildings included.
- **A starred building only changes the order**: it comes first among the building chips, and with no building picked
  its rooms and study spaces come right after the starred places in Study and Meet. It never filters: a filter is what
  the chips are for. Eat doesn't use it (the Eat tab orders by starred mensas and distance).
- **The building chips scroll sideways on phones** instead of wrapping into a block of five lines; "All" at the start
  says that nothing is picked. A dropdown list or a map-only choice were the alternatives (decisions in
  `plans/REVAMP_2_DECISIONS.md`).
- **The You tab shows "now"**, whatever time the other tabs are set to: it answers "is my library full right now".

## Invites

- **An invite opens the place, not the sender's list.** The receiver sees the room, study space or mensa they were
  invited to, with the sender's sentence above it and at the sender's time; the sender's buildings and filters aren't
  applied, and the receiver's own choices stay as they were.

## The time

- **The time wheel steps by 5 minutes and nothing carries over.** Rooms are booked by the quarter hour and meals
  change by the half hour, so minutes in between don't help; 5 keeps the wheel short (12 values) and still exact
  enough. The hours and minutes drums are independent, like a kitchen timer's: spinning the minutes past 55 doesn't
  move the hours, and the hours past 23 don't move the date; the calendar is the place for the day.
- **The date and time buttons stay clickable while Now is on.** They show the current date and time muted; a click
  opens the picker on them and the first change turns Now off. Disabling them until Now is clicked would be one click
  more and look broken.
- **A click beside an open picker keeps its value and closes it.** No Done or Cancel: what the calendar or the wheel
  shows is already the choice (the wheel picks as it settles), so a click elsewhere only confirms it, and that click
  still does what it's on. The picker closes when the click ends, not when it starts, so the list doesn't jump up
  under the pointer and the click lands where it was aimed.
- **The chosen time isn't kept across reloads.** The page opens on Now, as it always did: a time picked yesterday is
  rarely the one wanted today.

## Study

- **Rooms to study in come after the study spaces.** Computer rooms, seminar rooms and lecture halls free for an hour
  or more are listed below the open study spaces, in that order: a computer room has machines, a seminar room is
  quiet, a lecture hall is the last resort. Only those free for an hour: a room free for 20 minutes is no place to
  study, and busy rooms are Meet's business. The map's counts stay at lecture halls and seminar rooms free for 2 hours.
- **Study's mensa rows have no Menu button.** In Study a mensa is a place to sit; its row says until when ("Study space
  until lunch at 11:15"), and its view has the menu.

## Meet

- **Three room types: meeting rooms, seminar rooms and lecture halls.** The others (computer rooms, drawing rooms,
  teaching labs and so on) aren't places to meet and only crowded the filters; computer rooms are in Study.
  Meeting rooms stay opt-in, as before: Meet opens on the teaching rooms, and meeting rooms are one click away in More
  filters.
- **Rooms free for a chosen duration, not a fixed 2 hours.** Meet asks how long the room must stay free (30 min, 1 h,
  2 h or 3 h; 1 h by default) and lists the rooms free that long first, by building, three per building until "All 12
  in HG" is clicked. The map's room counts follow the same duration in Meet; the other tabs keep 2 hours.
- **The map's counts are lecture halls and seminar rooms only**, whatever room types and number of people the list is
  filtered to: the labels are a quick overview, the list is the answer.
- **No default building.** Meet lists the whole location without picking anything (from stored bookings, in one request);
  picked buildings filter it. Beyond the stored month bookings are fetched per building, so then a building must be
  picked (UZH has nothing that far ahead).
- **"Screen or projector" from ETH's room details**, fetched by frooms at night (10 rooms a run, each room once a
  month), not on demand: a presentation monitor or a projector counts; a document camera, HDMI or a board alone
  doesn't. Rooms whose details aren't known yet (and all of UZH's, which publishes none we read) aren't treated as
  having none: they stay findable in a group of their own.

## Reports and usual occupancy

- **Reports are anonymous and count for 2 hours.** No account, no IP address: a random id the browser keeps, stored only
  as its SHA-256, so one browser counts once per place and kind (a changed mind replaces its report). Someone with
  several devices or a cleared browser can count twice; the per-IP limit and a daily cap keep that small. Ratings of
  frooms' estimate are kept for us and never shown.
- **Reporting is one click, and only about now.** "Report occupancy" in a room's or open space's view: Free, Crowded
  or Full, or a percentage on a space where frooms has its own estimate (people compare against a number they can see).
  Not for a chosen time, a closed space, a room in a closed building or a room without data: a report is about what you see right now. The page
  remembers what you sent for 2 hours, so the view shows it and another click changes it rather than adding one.
- **"Usually this full" is half the past two months and half the past week** at that weekday and quarter hour (Raffaele's
  model), the two months alone when the past week has no reading then (a holiday, a sensor that was off), nothing with
  fewer than 3 readings. Rebuilt once a day, so today's readings count from tomorrow on.

## The map

- **Layers.** Buttons below the zoom buttons switch study spaces, rooms, mensas and cafeterias on and off (study
  spaces, rooms and mensas by default). Building labels show only the counts of the layers that are on, and are
  greyed when none of them has anything open or free.
- **Mensas and cafeterias have labels of their own only when zoomed in**, stacked under their building's label, so
  the zoomed-out map stays readable. With only mensas and cafeterias switched on, their labels show at every zoom
  level instead of the buildings'.
- **Closed mensas and cafeterias that aren't study spaces are left off the map**; tapping their building lists them
  in its sheet. Closed mensas that are study spaces stay, greyed.
- **Near you uses the location on the device only.** The page never asks for the position on load. If the browser
  already allows frooms to use it (the person said yes before), it's used on load to sort the lists by distance;
  otherwise only after a click on the locate button. It's kept in memory, never stored or sent (the distances are
  worked out in the page, from the campus drawing that's loaded anyway), and asked for only while the page is visible.
  Showing other people on the map was ruled out at first; with accounts the rule is now: **only friends who checked
  in themselves, only the place they picked, never a position** (`plans/PLAN_ACCOUNTS.md`, decision 7). The position
  still never leaves the device: in "Check in" it only picks the buildings to list.
- **Lists sort by building, not by room.** With the position known, every list puts the nearest buildings first and
  shows the straight-line distance to the building; rooms in the same building keep their order.
- **Near you suggests buildings, not rooms by distance.** GPS indoors is often off by tens of metres and has no floor,
  so the list is the nearest buildings with an open study space or a room free long enough (2 hours, or Meet's duration) (the same
  suggestion as the building's sheet), with the straight-line distance. Walking times aren't shown: the straight line
  isn't the way there. "You're in HG" is shown only when the position is exact to 60 m.
- **Flights instead of one big map.** Far campuses are reached by flying over a light overview of the land between
  them; you can't pan or zoom out there yourself, so each campus keeps its own limits and the list always matches the
  selected campus. Drawing everything between the campuses in full would make the map several MB.
- **Zentrum is one map with two campuses.** ETH's and UZH's buildings are drawn together, but only the selected
  campus's are highlighted and counted (each university's numbers come from its own `/api/map` answer), and you switch
  with the button on the other's main building. Showing both universities' counts at once would double the labels in
  Zentrum.
- **Cafeterias show on the map only when their layer is on.** A mensa whose layer is off still shows while it's a
  study space, with the study spaces.
- **Floor plans for ETH's buildings with rooms on frooms, not all of ETH.** HG, MM, CAB, CHN, CLA, ETA, ETF, ETZ, GLC,
  IFW, LEE, LFW and ML in Zentrum, HCI, HCP, HIL and HIT on Hönggerberg. They're made from ETH's plans (plan.ethz.ch,
  ETH login), so they stay on a preview until ETH agrees to frooms showing simplified plans. UZH's KOL would follow.
  A level with nothing on frooms, no link and no entrance is left out (ETZ D, ML G, HCI K, HIT G).
- **Floor plans are simplified.** Only lecture halls, seminar rooms, study spaces, mensas and cafeterias are shapes of
  their own; every other room and corridor is one neutral shape, and walls aren't drawn (the gaps between shapes read
  as walls). Room numbers come from where we put each seed, not from the plan (ETH's PDFs draw them as shapes).
- **Where a study space is only a zone in a corridor or hall** (HG's side wings, the library's atria, the corridors on
  J), its shape is the area ETH's plan marks, cut out by hand. Voids over the halls below (HG H's centre) are left out;
  the bigger ones on H and J are drawn as floor. The same goes for the other buildings: the big voids are left out (ML's
  machine hall, CHN's atrium above D, LFW's exhibition hall, HIL's courtyards), smaller ones and galleries are floor.
- **Rooms drawn as boxes.** Where a plan draws inner walls only as thin lines (IFW, HCI, HIL, HIT, GLC), a room's shape
  is the rectangle around it, read off the plan by hand; furniture, columns and partitions inside don't show.
- **Where OSM's outline isn't the floor's** (GLC, ETA, ETZ, ETF, LEE, CHN, IFW, HCP, LFW, CLA), the floor is clipped to
  an outline traced from the plan instead (`clip`), so a ground floor bigger or smaller than the roof still shows.
- **HCP shows only its west part.** ETH's sheet draws only that, and its position along the building comes from
  matching it to OSM's westmost block; it may be a few metres off.
- **Clausiusbar is one place on CLA D**, its second room (CLA D 1.1) a further shape of it, as `data/overrides.json`
  merges them; Kiosk CLA is part of it too and has no shape of its own.
- **Rice Up! (HIT E) is room 31**, the hall with its counter; ETH's data gives no room for it.
- **CLA D connects to LEE F** (by LEE's glass hall): ETH names the two buildings' floors differently there, so that link
  switches level as well as building.
- **Street levels are kept by hand** (`data/floors/levels.json`): switching buildings in the floor view lands on the
  level as many floors above or below street level, not on the same letter, since HG E and MM C are both at the
  street. Only HG's is backed by its main entrances; the others follow ETH's convention (E, MM C) and are a guess
  where the campus slopes. A wrong one lands a switch one floor off, which the level buttons fix in one click.
- **CAB's rooms are plain rectangles** and its lecture halls their shell outline, drawn by hand (`shapes`); the traced
  shapes took in stairs and side rooms.
- **A click on another building in the floor view doesn't move the map** (Raffaele, 15 November 2026): its plan opens
  where it is, since it was in view to be clicked; the title's menu still frames the new plan, which may be off screen.
  The other buildings carry their code as a tag, so they can be told apart on the faded campus.
- **A flight to another campus can be stopped** by dragging, pinching or scrolling during it: the map stays where the
  flight was and the switch still completes, so the lists and data follow the chosen campus.
- **A room free for less than 2 hours is pale green on the floor plan**, not red: it is free, just not for long
  enough to count on the campus map.
- **Einstein (MM C 81) and Zweistein (MM C 82) are two shapes on the plan** with one state: ETH and Cookpit have them
  as one study space and one place (MMC81, "Einstein & Zweistein").
- **HG and MM connect on level B only**: on C the way between them crosses Leonhardstrasse outdoors, so C shows HG's
  entrance there instead of a link.
- **CafeBar is drawn as part of the HG Lobby (HG E 30.7)**, where it is; Cookpit gives it no room of its own.

## Accounts, friends and check-ins

- **Sign-in with SWITCH edu-ID, ETH and UZH members only.** No passwords, no emails sent, no third-party script in the
  page: signing in is a plain link to `/auth/login` (the CSP stays as it is). Without an account everything else works
  as before, and frooms sets no cookies; signed in, two of its own (the 10-minute sign-in and the session), so no
  cookie banner.
- **People are bubbles.** Initials in two colours each person picks (contrast at least 3:1, checked on both ends), a
  username, and "Raffaele W."; no profile pictures, and others never get the last name or the email address.
- **Street cred's only reward is the bubble** (gradients from level 2 and 3, bronze, silver and gold from 4 to 6): it
  shows wherever you show up (friends, the map, the leaderboards) without giving anyone more reach. Gradients keep the
  3:1 rule for every pair of stops, and the metals are fixed designs (dark coins with bright letters for bronze and
  gold, a bright coin with dark letters for silver) so they read at the map's 26 px. A style once chosen stays if
  points are taken back (a 👎 flips): losing a look you already had would feel like a punishment for someone else's
  click.
- **Friends by request and accept**; a check-in is seen by all friends, never by anyone else. Blocking hides both from
  each other's search; reports go through the feedback form ("Report a person").
- **A check-in is always a listed place and always ends** (1, 2 or 3 hours, a time, or 3 hours by default). Nobody
  checks whether people are really there: frooms trusts them, as it trusts occupancy reports.
- **The account's views are detail views in the sheet** (kind `account`), with Back and history like any place, so
  there's no second navigation to learn.
- **Checking out where you are:** a place's view you're checked in to shows "Checked in" (the end time) and beside it
  a round red check-out button, like the You tab's; the end time window from there has "Check out" too. The end time
  is picked with the same time wheel as elsewhere (5-minute steps, within the next 12 hours), sent once it stays put.
- **About, Send feedback, Contact and Privacy** are in the account menu below a line, and stay in the You tab's footer
  for everyone (signed out there is no menu). About and Contact are views in the sheet like the account's.
- **The check-in button** sits bottom right above the tabs on phones and in the top bar on wide windows (decision
  12), hidden while a check-in runs and over a place's view (which has "Check in" itself). To be tried on a phone.
- **Friends on the map:** one bubble per building, above its label, merged with a count where bubbles would overlap,
  never hidden by the labels. Their own layer button, on by default.

## Street cred

- **Points for what others can see or use** (`worker/cred.ts`): friendships, check-ins, occupancy reports and votes
  on them, invites, problems and feedback, meal ratings. Signed in only: a signed-out action earns nothing and isn't
  kept for later (nothing to link it to without storing more).
- **Caps against farming** (per Zurich day: 4 check-ins, 10 reports, 20 report votes, 5 invites, 3 problems, 1
  feedback, 5 meal ratings), and a friendship counts once per pair ever. The caps are the plan's guess, not
  Raffaele's; `CAPS` in `cred.ts` is the one place to change them. Each is above what one honest day brings (a
  morning, lunch and an afternoon place; a report per room you pass) and low enough that clicking for points stops
  paying: on their own, at most 125 a day (friendships and 👍 from others come on top, each needing someone else), so gold
  takes over a week of maxing out every cap, and longer for everyone else.
- **The same place within 2 hours earns once:** checking out and in again, or moving back and forth, doesn't add up.
- **The log keeps 12 months; the all-time total stays** with the account. Friend rows stay as long as both accounts (the
  once-per-pair rule needs them). Report links and votes go after 2 days, as the Report log only shows 4 hours.
- **Report votes stay anonymous:** 👍 and 👎 counts, never who reported or voted, not even to friends; only your own
  report says "You". A per-reporter count or hash would let people tell reports of one person apart, so there is none.
- **Trusted reporters by 👍 received, not by points:** 20 👍 from others on your reports (all-time, with the account),
  shown as a round frooms icon without a name. It marks the report, not the person, and doesn't weigh more in the
  summaries: one person's report still counts once, so a trusted few can't tip a place to "full".
- **Votes signed in only, and never on your own:** a vote earns street cred and moves someone's trusted count, so it
  needs an account to cap it. A report sent signed out has no owner, so its sender could vote on it; it earns them only
  the voter's 1 point.
- **Meal ratings per day's serving, signed in only:** the same dish on another day starts again (the kitchen, the
  portion and the price change), and an account makes each person count once and caps the points. Ratings stay in the
  accounts database; the page shows averages and counts, never who rated.
- **Three optional categories, Ø their average:** taste, portion size and value for money each mean something
  different, and nobody has to have an opinion on all three. Ø is the mean of the category means (not of each person's
  own average), so a category many people rated doesn't drown the others.
- **Only today's and yesterday's dishes take ratings:** people rate what they ate, and a rating after the menu ended
  (yesterday's dinner) still counts; later than that it would be a guess. Older days still show their average.
- **Fetched apart from the menus:** `/api/menu` is cached 10 minutes for everyone; ratings change by the minute and are
  personal when signed in, so they come from their own call, once per open panel.
- **Points are for you and the leaderboards, nothing else:** they aren't used to weigh reports or ratings, rank people
  elsewhere or judge anyone, and the privacy notice promises that (its section "Street cred, ratings and votes").
- **The Street cred view leads with what you did**, then the numbers, then the leaderboards (the plan's order): the
  log is what people check after earning, and the leaderboards are opt-in, so they come last.
- **Leaderboards only for those who join, and only they see them:** a ranking shows a name next to a number; joining says
  exactly what others then see (username, "Raffaele W.", the bubble, the points), and leaving takes it all off at once.
- **One toast for every action that earns** ("+5 street cred", 3 s, above the tabs): a small reward where it happened,
  without a window to close. Nothing when an action earned 0 (a cap reached), so it never says "+0".
- **Invites earn after the invite went out**, never before and never in its way: the WhatsApp or Copy link click works
  as before, and the points call runs after it, its errors ignored.

## Usage counters

- **Daily totals without any identifier** (`worker/stats.ts`): to see how frooms is used without tracking anyone, a
  count is a metric, a Zurich day and a number. No user id, browser id, IP address, search text or place, so nothing
  can be linked to a person.
- **One row per day**, the day's counts as JSON: each beacon or counted action is one row write, and a year is about
  365 rows. In the accounts database, so the preview's tests never mix with frooms.ch's numbers.
- **The page counts locally and sends once when it's hidden** (`navigator.sendBeacon`): no request while someone is
  using the page, at most one a minute, and nothing waits on it.
- **The Worker counts its own events** (sign-ins, check-ins, ratings…) in the batch that writes them, and the beacon may
  not send those keys, so the page can't inflate them. Counts start when the table exists; there is no history before.
- **The admin page is for ids, not usernames** (`ADMIN_IDS`): a username can change and be taken by someone else.
  Everyone else gets the 404 of an unknown path, so the endpoint isn't advertised.
- **Visits from Cloudflare, not counted by us:** Web Analytics already counts visits without cookies; the admin page
  reads its daily totals through Cloudflare's API with a read-only token (Account Analytics: Read) rather than keeping
  a second visit count. Its days are UTC days and the page says so instead of converting. No token, no visits: the
  page links to the dashboard.
- **Tables first, counters where history is missing:** accounts, friendships, check-ins, reports and feedback are read
  from their own tables (complete history); only what isn't kept (sign-ins, deleted accounts, votes, page use) comes
  from the counters. Periods are Zurich days, like everything else on frooms.

## Tutorial

- **On frooms.ch itself, no subdomain** (`/?tutorial`). A subdomain would lose the visitor's stars and preferences
  (local storage is per origin) and the session cookie, and would need another edu-ID redirect URI.
- **The tour sends nothing** except stars. It walks through real buttons (Report occupancy, Check in, Rate, Invite), so a
  click there must not put a made-up report, check-in or rating in front of other people, earn street cred or send a
  message: those say "In the tutorial nothing is sent." instead. Stars are the person's own and undone with one click.
