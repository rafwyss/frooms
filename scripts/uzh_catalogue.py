#!/usr/bin/env python3
"""Build data/uzh_rooms_snapshot.json from UZH's room booking calendar (3V-Rooms) and data/uzh_libraries_snapshot.json
from the University Library's location list, and optionally the test fixtures.

Run by hand when UZH's rooms or libraries change (rarely):  python3 scripts/uzh_catalogue.py [--samples]

The calendar is public: the portal logs every visitor in anonymously (an OpenID redirect and a form post, no
password). One request per campus covers every room of it for a week; only the rooms are kept (id, location, title,
campus), never the bookings' comments, which hold names and emails. The Worker keeps the same list fresh itself
(worker/uzh.ts); this snapshot is its fallback and the input for scripts/make_map.py.

--samples also writes the fixtures the tests use (data/samples/uzh_*), with every comment removed.
"""

import argparse
import datetime as dt
import html
import http.cookiejar
import json
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "data" / "uzh.json").read_text())
BASE = "https://uzh.book.3vrooms.app"
PORTAL = f"{BASE}/default/Anonymous/Calendar/PortalFind"
API = f"{BASE}/default/api/v1.0/calendar"
USER_AGENT = "frooms/1.0 (+https://github.com/rafwyss/frooms; info@frooms.ch)"
GAP_S = 1.5


def context():
    try:  # python.org's macOS builds have no CA bundle of their own
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        system = Path("/etc/ssl/cert.pem")  # macOS's own bundle
        return ssl.create_default_context(cafile=str(system)) if system.exists() else None


class Session:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), urllib.request.HTTPSHandler(context=context()))
        self.last = 0.0

    def _open(self, url, data=None, headers=None):
        wait = self.last + GAP_S - time.time()
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with self.opener.open(req, timeout=60) as resp:
                return resp.read().decode("utf-8")
        finally:
            self.last = time.time()

    def login(self):
        page = self._open(PORTAL)
        form = dict(re.findall(r'name="(code|state|iss)" value="([^"]*)"', page))
        if "code" not in form:
            if "filtersettingSelector" in page:
                return  # already logged in
            sys.exit("UZH login: no authorisation form in the portal's answer")
        action = re.search(r'action="([^"]+)"', page).group(1)
        fields = {k: html.unescape(v) for k, v in form.items()}
        self._open(action, urllib.parse.urlencode(fields).encode(), {"Content-Type": "application/x-www-form-urlencoded"})

    def get(self, url, params=None):
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._open(url + query, headers={"IsAnonymousRequest": "True", "Accept": "application/json",
                                               "X-Requested-With": "XMLHttpRequest"})


# The fields worker/uzh.ts reads. Everything else is left out of the fixtures, above all `Kommentar`, the bookings'
# free text (names, emails, notes).
ROOM_FIELDS = ("Id", "Title", "BlockList")
BLOCK_FIELDS = ("Id", "EntryPart", "Titel", "Vorlauf", "BeginnEffective", "EndeEffective", "Nachlauf", "StatusFarbe")


def strip_comments(model):
    """The calendar answer with only the fields we use, and none of the bookings' free text."""
    def room(r):
        out = {k: r[k] for k in ROOM_FIELDS if k in r}
        out["BlockList"] = [{k: b.get(k) for k in BLOCK_FIELDS} for b in r.get("BlockList") or []]
        return out
    return {
        "RessourceList": [room(r) for r in model.get("RessourceList") or []],
        "StandortList": [{"Id": s["Id"], "RessourceList": [room(r) for r in s.get("RessourceList") or []]}
                         for s in model.get("StandortList") or []],
    }


DAYS = ("mo", "di", "mi", "do", "fr", "sa", "so")
# The fields worker/uzhspaces.ts reads from the library list (the Worker trims its own copy the same way).
LIBRARY_FIELDS = ("id", "bibname", "bibname_en", "adrzeile5gebbez", "raumbez", "standort", "anzarbeitsplatz",
                  "website", "website_alt", "bibstatus", "zuguzhcard") + tuple(
    f"{d}{k}{n}" for d in DAYS for k in ("von", "bis") for n in "12") + tuple(
    f"uzh{d}{k}" for d in DAYS for k in ("von", "bis"))
CLOSURE_FIELDS = ("schliessungvon", "schliessungbis", "art", "bezeichnung_en")


def trim_libraries(raw):
    return [{**{k: b.get(k) for k in LIBRARY_FIELDS},
             "bibSchliessungen": [{k: c.get(k) for k in CLOSURE_FIELDS} for c in b.get("bibSchliessungen") or []]}
            for b in raw]


def rooms_of(model, area):
    out = []
    for loc in model.get("StandortList") or []:
        for r in loc.get("RessourceList") or []:
            out.append({"id": r["Id"], "standort": int(loc["Id"]), "title": r["Title"].strip(), "area": area})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--samples", action="store_true", help="also write the test fixtures in data/samples/")
    args = ap.parse_args()

    s = Session()
    s.login()
    monday = dt.date.today() - dt.timedelta(days=dt.date.today().weekday())
    rooms = []
    for area, campus in CONFIG["campuses"].items():
        model = json.loads(s.get(API, {"mode": "Week", "from": monday.isoformat(),
                                       "to": (monday + dt.timedelta(days=7)).isoformat(),
                                       "filtersettingId": campus["filter"], "anlassId": ""}))
        found = rooms_of(model, area)
        print(f"{campus['label']}: {len(found)} rooms")
        rooms.extend(found)
        if args.samples and area == "UI":
            # One campus day, for the catalogue and day-splitting tests (comments removed).
            day = json.loads(s.get(API, {"mode": "Day", "from": (monday + dt.timedelta(days=1)).isoformat(),
                                         "to": (monday + dt.timedelta(days=2)).isoformat(),
                                         "filtersettingId": campus["filter"], "anlassId": ""}))
            (ROOT / "data" / "samples" / "uzh_calendar_day_irchel.json").write_text(
                json.dumps(strip_comments(day), ensure_ascii=False, separators=(",", ":")) + "\n")
    libraries = trim_libraries(json.loads(s.get(CONFIG["libraries_url"])))
    (ROOT / "data" / "uzh_libraries_snapshot.json").write_text(json.dumps(libraries, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote data/uzh_libraries_snapshot.json ({len(libraries)} locations)")
    rooms.sort(key=lambda r: (r["area"], r["title"]))
    (ROOT / "data" / "uzh_rooms_snapshot.json").write_text(json.dumps(rooms, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote data/uzh_rooms_snapshot.json ({len(rooms)} rooms)")

    if args.samples:
        samples = ROOT / "data" / "samples"
        room = next(r for r in rooms if r["id"] == 51)
        start = dt.datetime.combine(monday, dt.time()).isoformat() + ".000Z"
        end = dt.datetime.combine(monday + dt.timedelta(days=32), dt.time()).isoformat() + ".000Z"
        one = json.loads(s.get(API, {"from": start, "to": end, "mode": 2, "standortId": room["standort"],
                                     "id": room["id"], "displayFullDay": "false"}))
        (samples / "uzh_calendar_room51.json").write_text(
            json.dumps(strip_comments(one), ensure_ascii=False, indent=1) + "\n")
        sensor = s._open(f"{CONFIG['occupancy_url']}?id=2")
        (samples / "uzh_occusense_2.html").write_text(sensor)
        print("Wrote data/samples/uzh_calendar_room51.json, uzh_calendar_day_irchel.json, uzh_occusense_2.html")


if __name__ == "__main__":
    main()
