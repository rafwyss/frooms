#!/usr/bin/env python3
"""Build the map view's drawing (static/map/) from OpenStreetMap: each campus's buildings, the region's tiles and
the overview.

Run by hand when buildings change (rarely):  python3 scripts/make_map.py --cache data/cache/osm

For each campus in data/map/campuses.json this queries Overpass once and writes the campus's buildings (by code,
in metres around the campus) and landmarks to static/map/<area>.json. Then the region around all of them (see
region_bounds) is queried in REGION_CHUNK_M chunks and cut into REGION_TILE_M tiles (static/map/region/<col>_<row>.json,
with index.json): houses, roads, paths, tram and funicular lines, green and water, simplified, one path string per
layer, with the campuses' own buildings left out. Only the land between the campuses is detailed: the zone within
ZONE_M of the hull around every campus's buildings. Over the next FADE_M the detail thins out (paths first, then
houses and small streets, main roads, rail and water last); beyond it the overview alone. ETH buildings are matched by OSM's 'ETH <code>' tag (addr:housename, or a name ending in '(<code>)').
Every building with lecture halls, seminar rooms or study spaces (data/rooms_snapshot.json, data/spaces_snapshot.json)
must be found, or the script fails. Buildings with only mensas (and places with menus only, data/overrides.json
`eateries`) are drawn if OSM has them.

UZH campuses (the areas in data/uzh.json) work the same way with OSM's 'UZH-<code>' tag, for the buildings with rooms
(data/uzh_rooms_snapshot.json) or libraries (data/uzh_libraries_snapshot.json). Where OSM has no such tag, the campus
entry names the outline itself (`buildings`: {"KOL": {"osm": ["relation/123300"]}} or {"contains": [lat, lon]}, the
outline around a point such as a tagged entrance), and buildings drawn as part of another are mapped to it
(data/uzh.json `map_buildings`). A building that can't be found must be listed in `not_on_map` with the reason; it's
written as a label-only building (no outline, no anchor, `"outline": false`), which the map shows only where
static/map/pins.json places it. Where OSM draws two buildings as one outline, `splits` cuts it in two along a line
(KO2 off KOL's outline).

The overview (static/map/overview.json, made with the region) is a light map of the whole region: main roads, rail,
rivers, lakes and big forests, simplified to a few metres. The app shows it zoomed out, and under tiles not loaded yet.

Map data © OpenStreetMap contributors, ODbL. The app credits it on the map.
"""

import argparse
import json
import math
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UZH = json.loads((ROOT / "data" / "uzh.json").read_text())
# Our own categories for some spaces (see worker/overrides.ts): a mensa moved to the study spaces is no mensa here.
OVERRIDES = json.loads((ROOT / "data" / "overrides.json").read_text())["spaces"]
# Places with menus only (Bellavista, Octavo, ...): their buildings are mensa buildings too.
EATERIES = json.loads((ROOT / "data" / "overrides.json").read_text())["eateries"]
# Our own study spaces and workspaces (the Student Project Houses, Fabrik): each has a building drawn (SPHZ, SPHH, LEO).
EXTRA_SPACES = json.loads((ROOT / "data" / "overrides.json").read_text()).get("extra_spaces", {})
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "frooms map builder (+https://frooms.ch; info@frooms.ch)"
ROOM_TYPES = {"3430", "3420"}  # lecture halls, seminar rooms (DEFAULT_TYPECODES)
SPACE_CAMPUS = {"Z": "ZZ", "H": "ZH"}
MARGIN_M = 220  # shown around the labelled buildings
SIMPLIFY_M = 0.6

ROAD_CLASS = {
    "primary": "major", "secondary": "major", "tertiary": "major",
    "residential": "minor", "unclassified": "minor", "living_street": "minor", "busway": "minor",
    "service": "service", "pedestrian": "service",
    "footway": "foot", "path": "foot", "steps": "foot", "cycleway": "foot", "track": "foot",
}


def overpass(box, cache: Path | None, key: str, parts: bool = False):
    if cache and (cache / f"{key}.json").exists():
        return json.loads((cache / f"{key}.json").read_text())["elements"]
    b = ",".join(str(v) for v in box)
    return overpass_query(f"""[out:json][timeout:120];(
      way["building"]({b}); relation["building"]({b});{f"""
      way["building:part"]["addr:housename"~"^UZH"]({b});""" if parts else ""}
      way["highway"]({b});
      way["railway"~"^(tram|funicular|rail|light_rail)$"]({b});
      way["leisure"~"^(park|garden|pitch|playground)$"]({b}); relation["leisure"="park"]({b});
      way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground|allotments)$"]({b});
      relation["landuse"~"^(forest|grass|meadow)$"]({b});
      way["natural"~"^(water|wood)$"]({b}); relation["natural"~"^(water|wood)$"]({b});
      way["waterway"="river"]({b});
    );out geom;""", cache, key)


def overpass_query(query, cache: Path | None, key: str):
    """Ask Overpass (with retries), keeping the answer in `cache` if given."""
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": query}).encode(),
                                 headers={"User-Agent": USER_AGENT})
    try:  # python.org's macOS builds have no CA bundle of their own
        import certifi
        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        context = None
    attempts = 6
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=180, context=context) as resp:
                body = resp.read()
            break
        except Exception as e:  # Overpass is often busy; wait longer each time and retry
            if attempt == attempts - 1:
                raise
            wait = 20 * (attempt + 1)
            print(f"  Overpass failed ({e}), retrying in {wait} s", file=sys.stderr)
            time.sleep(wait)
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / f"{key}.json").write_bytes(body)
    return json.loads(body)["elements"]


class Projection:
    """Local equirectangular projection in metres (x east, y south), accurate to centimetres at campus scale."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110574

    def __call__(self, lat, lon):
        return ((lon - self.lon0) * self.kx, -(lat - self.lat0) * self.ky)


def rings(el, proj):
    if el["type"] == "way":
        return [[proj(p["lat"], p["lon"]) for p in el.get("geometry", [])]]
    out = []
    for m in el.get("members", []):
        if m.get("type") == "way" and m.get("role") in ("outer", "inner", "") and m.get("geometry"):
            out.append([proj(p["lat"], p["lon"]) for p in m["geometry"]])
    return join_rings(out)


def join_rings(parts):
    """Multipolygon members are often split ways; join them into closed rings where their ends meet."""
    done, open_ = [], []
    for p in parts:
        (done if p[0] == p[-1] else open_).append(list(p))
    while open_:
        ring = open_.pop()
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, p in enumerate(open_):
                if p[0] == ring[-1]:
                    ring += p[1:]
                elif p[-1] == ring[-1]:
                    ring += p[-2::-1]
                elif p[-1] == ring[0]:
                    ring = p[:-1] + ring
                elif p[0] == ring[0]:
                    ring = p[:0:-1] + ring
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        done.append(ring)
    return done


def simplify(pts, tol=SIMPLIFY_M):
    """Douglas-Peucker."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy)
    best, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm if norm else math.hypot(px - x1, py - y1)
        if d > best:
            best, idx = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def d_attr(rs, closed, tol=SIMPLIFY_M, digits=1):
    """SVG path data. Background layers use whole metres (digits=0), ETH buildings decimetres."""
    out = []
    for r in rs:
        r = simplify(r, tol)
        if len(r) < (3 if closed else 2):
            continue
        if closed and r[0] == r[-1]:
            r = r[:-1]
        coords = [(round(x, digits), round(y, digits)) for x, y in r]
        coords = [c for i, c in enumerate(coords) if i == 0 or c != coords[i - 1]]
        if len(coords) < (3 if closed else 2):
            continue
        fmt = (lambda v: f"{v:.0f}") if digits == 0 else (lambda v: f"{v:.{digits}f}")
        out.append("M" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in coords) + ("Z" if closed else ""))
    return "".join(out)


def area_centroid(r):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if abs(a) < 1e-9:
        return sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a) / 2


def inside(x, y, poly):
    c = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def label_anchor(rs):
    """Centroid of the biggest part; if that falls outside it (U shapes), the part's vertex average or bbox centre."""
    best = max(rs, key=lambda r: area_centroid(r)[2])
    x, y, _ = area_centroid(best)
    if inside(x, y, best):
        return x, y
    xs, ys = [p[0] for p in best], [p[1] for p in best]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


CODE_TAG = re.compile(r"^(?:ETH|ETH/UZH|UZH-\S+/ETH)\s+([A-Z]{1,4})$")
CODE_IN_NAME = re.compile(r"\(([A-Z]{1,4})\)\s*$")


def eth_code(tags):
    for key in ("addr:housename", "name"):
        v = tags.get(key, "").strip()
        m = CODE_TAG.match(v) or (CODE_IN_NAME.search(v) if key == "name" and "ETH" in v else None)
        if m:
            return m.group(1)
    return None


def needed_codes(area):
    rooms = json.loads((ROOT / "data" / "rooms_snapshot.json").read_text())
    spaces = json.loads((ROOT / "data" / "spaces_snapshot.json").read_text())
    codes = {r["building"] for r in rooms if r.get("area") == area and r.get("typecode") in ROOM_TYPES}
    mensa = set()
    for s in spaces:
        a = s["attributes"]
        if a.get("campus") != SPACE_CAMPUS[area]:
            continue
        category = OVERRIDES.get(a["roomGlobalIdentifier"], {}).get("category")
        if category == "mensa" or (category is None and a["roomType"]["code"] == "3300"):
            mensa.add(a["building"])
        else:
            codes.add(a["building"])
    facilities = json.loads((ROOT / "data" / "eateries_snapshot.json").read_text())["facility-array"]
    cookpit = {str(f["facility-id"]): f for f in facilities}
    for fid, e in EATERIES.items():
        if fid.startswith("_") or e.get("space") or e.get("hidden") or e.get("merge_into") or e.get("area") != area:
            continue
        building = e.get("building") or cookpit.get(fid, {}).get("building")
        if building:
            mensa.add(building)
    # Not `map: false` ones (IPZ Hangar, outside every campus).
    codes |= {x["building"] for k, x in EXTRA_SPACES.items() if not k.startswith("_") and x.get("area") == area and x.get("map", True)}
    return codes, mensa - codes


UZH_CODE = re.compile(r"^UZH[- ]([A-Z][A-Z0-9]{2})\b")
UZH_TITLE = re.compile(r"^([A-Z][A-Z0-9]{2})-[A-Za-z0-9]{1,2}-")


def uzh_code(tags):
    for key in ("addr:housename", "name"):
        m = UZH_CODE.match(tags.get(key, "").strip())
        if m:
            return m.group(1)
    return None


def uzh_needed(area):
    """UZH buildings with rooms or libraries in `area`, and those with only a mensa, as drawn (data/uzh.json map_buildings)."""
    alias = UZH.get("map_buildings", {})
    rooms = json.loads((ROOT / "data" / "uzh_rooms_snapshot.json").read_text())
    codes = {m.group(1) for r in rooms if r["area"] == area and (m := UZH_TITLE.match(r["title"]))}
    campuses = UZH["library_campuses"]
    sensored = {s["bib"] for s in UZH["sensors"].values()}
    for b in json.loads((ROOT / "data" / "uzh_libraries_snapshot.json").read_text()):
        if campuses.get(b.get("standort")) == area and b.get("bibstatus") == "Aktiv" and b.get("adrzeile5gebbez") and (
                (b.get("anzarbeitsplatz") or 0) > 0 or b["id"] in sensored):
            codes.add(b["adrzeile5gebbez"].strip())
    drawn = {alias.get(c, c) for c in codes}
    # Buildings with a mensa or café (data/uzh.json `mensas`, `cafes`): MEN, the Mensa building, has no rooms of its own.
    mensa = {alias.get(m["building"], m["building"]) for m in UZH.get("mensas", []) + UZH.get("cafes", []) if m["area"] == area}
    return drawn, mensa - drawn


def build(area, conf, cache):
    print(f"{area} ({conf['name']}):")
    uzh = area in UZH["campuses"]
    # UZH tags some buildings only as a building part (PET): those count as outlines too.
    els = overpass(conf["fetch"], cache, f"osm_{area}", parts=uzh)
    s, w, n, e = conf["fetch"]
    proj = Projection((s + n) / 2, (w + e) / 2)
    need, mensa_only = uzh_needed(area) if uzh else needed_codes(area)
    labelled = need | mensa_only
    # Outlines named in the campus entry, by id (any campus) or by a point inside them (UZH).
    explicit = conf.get("buildings", {})
    by_id = {ref: code for code, b in explicit.items() for ref in b.get("osm", [])}
    inside_of = {code: proj(*b["contains"]) for code, b in explicit.items() if "contains" in b}

    def code_of(el, t, rs):
        # An outline named in the campus entry wins (ETH too: HPZ is drawn as SPHH, the Student Project House).
        if f"{el['type']}/{el['id']}" in by_id:
            return by_id[f"{el['type']}/{el['id']}"]
        if not uzh:
            return eth_code(t)
        for code, (px, py) in inside_of.items():
            if any(len(r) > 2 and inside(px, py, r) for r in rs):
                return code
        return uzh_code(t)

    eth_parts: dict[str, list] = {}
    campus_ids = set()  # the OSM elements drawn as this campus's buildings (left out of the region's tiles)
    for el in els:
        t = el.get("tags", {})
        if uzh and "building" not in t and "building:part" in t:
            t = {**t, "building": "yes"}
        if "building" in t:
            if not drawn_building(t):
                continue
            rs = rings(el, proj)
            code = code_of(el, t, rs)
            if code in labelled:
                eth_parts.setdefault(code, []).extend(rs)
                campus_ids.add(f"{el['type']}/{el['id']}")

    split_buildings(eth_parts, conf.get("splits", {}), proj)
    carve_buildings(eth_parts, conf.get("carve", {}), proj)
    unmapped = conf.get("not_on_map", {})
    label_only = sorted((need | mensa_only) & unmapped.keys() - eth_parts.keys())
    for code in label_only:
        print(f"  ({code} has no outline, label only: {unmapped[code]})")
    missing = sorted(need - eth_parts.keys() - unmapped.keys())
    if missing:
        sys.exit(f"  No OSM outline for {', '.join(missing)}: tag them in OSM, name them in campuses.json or extend eth_code()")
    for code in sorted(mensa_only - eth_parts.keys() - unmapped.keys()):
        print(f"  (mensa-only building {code} not found, left out)")

    # Visible area: the labelled buildings plus a margin; everything else is dropped.
    # A campus spread out in one direction gets more margin in the other (`extra_margin_m`: [x, y]), so a tall
    # map panel can still zoom out far enough to show all of it (Oerlikon: AFL is 650 m west of the others).
    mx, my = (MARGIN_M + extra for extra in conf.get("extra_margin_m", (0, 0)))
    pts = [p for rs in eth_parts.values() for r in rs for p in r]
    x0, x1 = min(p[0] for p in pts) - mx, max(p[0] for p in pts) + mx
    y0, y1 = min(p[1] for p in pts) - my, max(p[1] for p in pts) + my

    offsets = conf.get("label_offsets", {})
    buildings = {}
    for code in sorted(eth_parts):
        rs = eth_parts[code]
        ax, ay = label_anchor(rs)
        dx, dy = offsets.get(code, (0, 0))
        buildings[code] = {
            "d": d_attr(rs, True),
            "x": round(ax + dx, 1),
            "y": round(ay + dy, 1),
            "size": round(sum(area_centroid(r)[2] for r in rs)),  # m², bigger buildings win label collisions
            "name": conf.get("names", {}).get(code),
            "mensa": code in mensa_only,
        }
    # No outline in OSM: a label without an anchor, shown only where static/map/pins.json puts it. Size 0, so every
    # drawn building wins a label collision.
    for code in label_only:
        buildings[code] = {"d": "", "outline": False, "size": 0, "name": conf.get("names", {}).get(code), "mensa": code in mensa_only}
    landmarks = []
    for lm in conf.get("landmarks", []):
        x, y = proj(lm["lat"], lm["lon"])
        landmarks.append({"type": lm["type"], "x": round(x, 1), "y": round(y, 1), "r": lm.get("r", 10)})

    doc = {
        "area": area,
        "name": conf["name"],
        "bounds": [round(x0), round(y0), round(x1), round(y1)],
        "origin": [round(proj.lat0, 7), round(proj.lon0, 7)],  # lat, lon of x = y = 0, so the app can place a GPS position on the map
        "buildings": buildings,
        "landmarks": landmarks,
        "attribution": "© OpenStreetMap contributors",
    }
    path = ROOT / "static" / "map" / f"{area}.json"
    path.parent.mkdir(exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text)
    print(f"  {len(buildings) - len(label_only)} {'UZH' if uzh else 'ETH'} buildings drawn"
          f"{f' (+{len(label_only)} label only)' if label_only else ''}, {round(x1 - x0)} x {round(y1 - y0)} m, "
          f"{len(text) // 1024} KB -> {path.relative_to(ROOT)}")
    return doc, campus_ids


def clip_half(ring, a, b, keep_left):
    """The part of a ring on one side of the line through a and b (Sutherland-Hodgman against one half-plane): the
    left side (seen from a towards b, in x east / y south metres) with `keep_left`, else the right. Closed if it was."""
    def side(p):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    closed = len(ring) > 1 and ring[0] == ring[-1]
    pts = ring[:-1] if closed else ring
    inside_ = (lambda v: v <= 0) if keep_left else (lambda v: v >= 0)
    out = []
    for i, q in enumerate(pts):
        p = pts[i - 1]
        sp, sq = side(p), side(q)
        if inside_(sq):
            if not inside_(sp):
                f = sp / (sp - sq)
                out.append((p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])))
            out.append(q)
        elif inside_(sp):
            f = sp / (sp - sq)
            out.append((p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])))
    if closed and out:
        out.append(out[0])
    return out


def split_buildings(parts, splits, proj):
    """Cut one OSM outline into two buildings (campuses.json `splits`): {code: {"into": other, "line": [[lat, lon],
    [lat, lon]], "side": [lat, lon], "solid": true}}, the line through the two points dividing them and `side` a point
    in `into`'s part; `solid` drops `into`'s courtyards (drawn as part of the building). Rings left with fewer than 3 points (a courtyard on the other side) are dropped."""
    for code, sp in splits.items():
        if code not in parts:
            sys.exit(f"  Split {code} -> {sp['into']}: no outline for {code}")
        a, b = proj(*sp["line"][0]), proj(*sp["line"][1])
        sx, sy = proj(*sp["side"])
        left = (b[0] - a[0]) * (sy - a[1]) - (b[1] - a[1]) * (sx - a[0]) <= 0
        rs = parts[code]
        parts[sp["into"]] = [r for r in (clip_half(r, a, b, left) for r in rs) if len(r) >= 4]
        if sp.get("solid"):  # its courtyard is part of the building: the outer ring only
            parts[sp["into"]] = [max(parts[sp["into"]], key=lambda r: abs(area_centroid(r)[2]))]
        parts[code] = [r for r in (clip_half(r, a, b, not left) for r in rs) if len(r) >= 4]
        print(f"  {code} split: {sp['into']} cut off its outline ({sp.get('_why', '')})")


def _seg_cross(p, r, a, b):
    """Where segment p-r crosses segment a-b, as (t along p-r, point), or None."""
    d = (r[0] - p[0]) * (b[1] - a[1]) - (r[1] - p[1]) * (b[0] - a[0])
    if abs(d) < 1e-12:
        return None
    t = ((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])) / d
    u = ((a[0] - p[0]) * (r[1] - p[1]) - (a[1] - p[1]) * (r[0] - p[0])) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return t, (p[0] + t * (r[0] - p[0]), p[1] + t * (r[1] - p[1]))
    return None


def carve(ring, q):
    """Cut the convex polygon q (open, metres) out of a closed ring: (the part inside q, the rest), both closed and
    sharing the cut's points exactly, so the two outlines join without a gap. The ring's outline must cross q's twice."""
    pts = ring[:-1]
    cx, cy = sum(v[0] for v in q) / len(q), sum(v[1] for v in q) / len(q)
    inside_q = lambda v: inside(v[0], v[1], q)
    inner = ring
    for a, b in zip(q, q[1:] + q[:1]):
        keep_left = (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) <= 0
        inner = clip_half(inner, a, b, keep_left)
    # The rest: the ring's own points outside q, and where it enters q, q's corners inside the ring up to where it leaves.
    n = len(pts)
    start = next(i for i in range(n) if not inside_q(pts[i]))
    out, crossings = [], 0
    for k in range(n):
        p, r = pts[(start + k) % n], pts[(start + k + 1) % n]
        if not inside_q(p):
            out.append(p)
        if inside_q(p) == inside_q(r):
            continue
        hits = [(h, i) for i, (a, b) in enumerate(zip(q, q[1:] + q[:1])) if (h := _seg_cross(p, r, a, b))]
        (t, at), edge = min(hits)
        crossings += 1
        if not inside_q(p):  # entering q: the cut point, then q's corners inside the ring to the edge it leaves by
            enter_edge, out_at = edge, len(out)
            out.append(at)
        else:
            leave_edge = edge
            fwd = [q[(enter_edge + 1 + j) % len(q)] for j in range((leave_edge - enter_edge) % len(q))]
            back = [q[(enter_edge - j) % len(q)] for j in range((enter_edge - leave_edge) % len(q))]
            corners = fwd if all(inside(v[0], v[1], pts) for v in fwd) else back
            out[out_at + 1:out_at + 1] = corners
            out.append(at)
    if crossings != 2:
        sys.exit(f"  carve: the outline crosses the cut {crossings} times, not twice")
    return inner, out + out[:1]


def simplify_keeping(ring, keep, tol):
    """A closed ring simplified (Douglas-Peucker) between the points in `keep`, which all stay."""
    pts = ring[:-1]
    marks = [i for i, v in enumerate(pts) if v in keep]
    if len(marks) < 2:
        return ring
    out = []
    for a, b in zip(marks, marks[1:] + [marks[0] + len(pts)]):
        piece = [pts[i % len(pts)] for i in range(a, b + 1)]
        out.extend(simplify(piece, tol)[:-1])
    return out + out[:1]


def carve_buildings(parts, carves, proj):
    """Cut a building of our own out of another's outline (campuses.json `carve`): {code: {"from": other, "polygon":
    [[lat, lon], ...], "simplify_m": 1.0}}, a convex polygon around the part (beyond the outline where it follows the
    outline). The other keeps the rest as one outline, joined to the new one along the cut; both lose OSM's steps under
    `simplify_m` along their walls."""
    for code, c in carves.items():
        src = c["from"]
        if src not in parts or len(parts[src]) != 1:
            sys.exit(f"  Carve {code} from {src}: {src} needs exactly one outline")
        q = [proj(*v) for v in c["polygon"]]
        inner, rest = carve(parts[src][0], q)
        # Small steps OSM has along the walls go (`simplify_m`), but never the cut's points, so the seam stays shared.
        tol = c.get("simplify_m", SIMPLIFY_M)
        shared = set(inner) & set(rest)
        parts[code], parts[src] = [simplify_keeping(inner, shared, tol)], [simplify_keeping(rest, shared, tol)]
        print(f"  {code} carved out of {src} ({c.get('_why', '')})")


def drawn_building(t):
    """A building drawn on the map (not a roof, a building site or underground)."""
    return t.get("building") not in ("roof", "construction") and t.get("location") != "underground"


def background_layer(t):
    """The map layer an OSM element that isn't a building goes into, or None to leave it out."""
    if "highway" in t:
        if t.get("tunnel") in ("yes", "building_passage") or t.get("indoor") == "yes" or t.get("highway") == "corridor":
            return None
        if t.get("area") == "yes" and t["highway"] in ("pedestrian", "footway"):
            return "plaza"
        return ROAD_CLASS.get(t["highway"])
    if t.get("railway") == "funicular":
        return "funicular"
    if "railway" in t:
        return None if t.get("tunnel") == "yes" else "rail"
    if t.get("waterway") == "river":
        return "river"
    if t.get("natural") == "water":
        return "water"
    return "green"


OVERVIEW_ROADS = "motorway|trunk|primary|secondary|tertiary"
OVERVIEW_MIN_GREEN_M2 = 20000  # forests and woods at least this big

# The region: one map around all the campuses, cut into square tiles the app loads as they come into view.
REGION_TILE_M = 500
REGION_CHUNK_M = 1500  # queried from Overpass this big at a time (one query for all of it would time out)
REGION_NORTH_MARGIN_M = 300  # above the northernmost campus (Oerlikon)
# Zentrum (between HG and KOL, the app's CAMPUS_POINTS.ZENTRUM) is the region's origin. Fully zoomed out in the
# bottom-right corner, it should be this far from the right and bottom edges (as a part of the view; the view is about
# as tall as wide, and fully zoomed out spans the region's width).
ZENTRUM = (47.37575, 8.54805)
ZENTRUM_FROM_EDGE = 0.4
CLOSED_LAYERS = {"green", "water", "plaza", "other", "eth"}
LINE_LAYERS = ("river", "major", "minor", "service", "foot", "rail", "funicular")
COARSE_M = {"water": 2.5, "river": 2.5, "green": 1.5}
# The detailed zone: this far (m, about one campus's width) around the hull of all the campuses' buildings, then
# thinning out over FADE_M (half that). Each feature has its own end within the fade (FADE_END), so it fizzles out
# rather than stopping at a line.
ZONE_M = 600
FADE_M = 300
# Where in the fade a layer's features end, as parts of FADE_M: (first, last). Each feature gets a random point in
# between (the same on every run). A building ends with its middle, a line where it crosses its end.
FADE_END = {
    "foot": (0.0, 0.5), "plaza": (0.0, 0.6), "service": (0.05, 0.7), "other": (0.0, 1.0), "eth": (0.2, 1.0),
    "green": (0.0, 1.0), "minor": (0.3, 1.0), "tram": (0.5, 1.0), "funicular": (1.0, 1.0),
    "major": (1.0, 1.0), "rail": (1.0, 1.0), "river": (1.0, 1.0), "water": (1.0, 1.0),
}


def region_bounds(docs):
    """The region in metres around Zentrum: [x0, y0, x1, y1]. See ZENTRUM_FROM_EDGE; on the left, one Hönggerberg
    width of land beyond Hönggerberg; at the top a margin above Oerlikon."""
    proj = Projection(*ZENTRUM)

    def campus_box(doc):
        ox, oy = proj(*doc["origin"])
        b = doc["bounds"]
        return [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy]

    boxes = [campus_box(d) for d in docs.values()]
    h = campus_box(docs["H"])
    x0 = h[0] - (h[2] - h[0])
    y0 = min(b[1] for b in boxes) - REGION_NORTH_MARGIN_M
    # x1 - 0 = f * (x1 - x0)  ->  x1 = -f * x0 / (1 - f); the view is as tall as the region is wide, so the same below.
    x1 = -ZENTRUM_FROM_EDGE * x0 / (1 - ZENTRUM_FROM_EDGE)
    y1 = ZENTRUM_FROM_EDGE * (x1 - x0)
    return proj, [round(x0), round(y0), round(x1), round(y1)]


def convex_hull(pts):
    """Andrew's monotone chain; counter-clockwise with y up (clockwise on the map, where y points south)."""
    pts = sorted(set(pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


class Zone:
    """The detailed zone: the convex hull of every campus's buildings (region metres), and distances from it."""

    def __init__(self, docs, proj):
        pts = []
        for doc in docs.values():
            ox, oy = proj(*doc["origin"])
            for b in doc["buildings"].values():
                nums = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", b.get("d", ""))]
                pts += [(round(x + ox), round(y + oy)) for x, y in zip(nums[::2], nums[1::2])]
        self.hull = convex_hull(pts)
        self.edges = [(a, b) for a, b in zip(self.hull, self.hull[1:] + self.hull[:1])]

    def dist(self, x, y):
        """Metres outside the hull (0 inside)."""
        best, inside = math.inf, True
        for (ax, ay), (bx, by) in self.edges:
            dx, dy = bx - ax, by - ay
            if dx * (y - ay) - dy * (x - ax) < 0:
                inside = False
            t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
        return 0.0 if inside else best

    def polygon(self, r, step_deg=10):
        """The hull widened by r metres, its corners rounded."""
        out = []
        n = len(self.hull)
        for i, (vx, vy) in enumerate(self.hull):
            (px, py), (nx, ny) = self.hull[i - 1], self.hull[(i + 1) % n]
            a0 = math.atan2(-(vx - px), vy - py)  # outward normals (dy, -dx) of the edges in and out
            a1 = math.atan2(-(nx - vx), ny - vy)
            if a1 < a0:
                a1 += 2 * math.pi
            k = max(1, math.ceil(math.degrees(a1 - a0) / step_deg))
            out += [(vx + r * math.cos(a0 + (a1 - a0) * j / k), vy + r * math.sin(a0 + (a1 - a0) * j / k))
                    for j in range(k + 1)]
        return out

    def trim(self, line, limit, step=15.0):
        """The parts of a polyline within `limit` metres of the hull."""
        if all(self.dist(x, y) <= ZONE_M for x, y in line):  # the widened hull is convex: all of it is in
            return [line]
        pieces, cur = [], []
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            k = max(1, math.ceil(math.hypot(bx - ax, by - ay) / step))
            for j in range(0 if not cur and (ax, ay) == line[0] else 1, k + 1):
                p = (ax + (bx - ax) * j / k, ay + (by - ay) * j / k)
                if self.dist(*p) <= limit:
                    cur.append(p)
                else:
                    if len(cur) > 1:
                        pieces.append(cur)
                    cur = []
        if len(cur) > 1:
            pieces.append(cur)
        return pieces


def fade_end(layer, ref):
    """How far (m) from the hull this feature goes: ZONE_M plus its own point in the fade (see FADE_END)."""
    lo, hi = FADE_END[layer]
    u = zlib.crc32(ref.encode()) / 2**32
    return ZONE_M + FADE_M * (lo + (hi - lo) * u)


def to_latlon(proj, x, y):
    return proj.lat0 - y / proj.ky, proj.lon0 + x / proj.kx


def clip_ring(ring, box):
    """Sutherland-Hodgman: a polygon ring cut to a box [x0, y0, x1, y1]."""
    x0, y0, x1, y1 = box
    edges = [(lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
             (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
             (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1))]
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    for keep, cut in edges:
        if not pts:
            break
        out = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            if keep(cur):
                if not keep(prev):
                    out.append(cut(prev, cur))
                out.append(cur)
            elif keep(prev):
                out.append(cut(prev, cur))
        pts = out
    return pts if len(pts) >= 3 else None


def clip_line(line, box):
    """A polyline cut to a box: the pieces inside it (Liang-Barsky per segment)."""
    x0, y0, x1, y1 = box
    pieces, cur = [], []
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        dx, dy = bx - ax, by - ay
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    t0 = max(t0, r)
                else:
                    t1 = min(t1, r)
        if not ok or t0 > t1:
            if len(cur) > 1:
                pieces.append(cur)
            cur = []
            continue
        a = (ax + t0 * dx, ay + t0 * dy)
        b = (ax + t1 * dx, ay + t1 * dy)
        if not cur:
            cur = [a]
        cur.append(b)
        if t1 < 1:  # leaves the box here
            pieces.append(cur)
            cur = []
    if len(cur) > 1:
        pieces.append(cur)
    return pieces


def build_region(docs, campus_ids, cache):
    """The region's tiles (static/map/region/), with every campus's buildings left out (the campus files draw them).
    Only the detailed zone has them (see Zone, FADE_END)."""
    print("region:")
    proj, (x0, y0, x1, y1) = region_bounds(docs)
    print(f"  {x1 - x0} x {y1 - y0} m around Zentrum")
    zone = Zone(docs, proj)
    ground = zone.polygon(ZONE_M)  # the overview is covered here (the detail has all it has)
    if y1 - y0 < x1 - x0:
        print("  (shorter than wide: fully zoomed out, the view spans its height, not its width)", file=sys.stderr)
    t = REGION_TILE_M
    cols, rows = math.ceil((x1 - x0) / t), math.ceil((y1 - y0) / t)
    tiles: dict[tuple, dict[str, list]] = {}

    def add(key, layer, item):
        tiles.setdefault(key, {}).setdefault(layer, []).append(item)

    def tile_box(c, r, pad=0.0):
        return (x0 + c * t - pad, y0 + r * t - pad, x0 + (c + 1) * t + pad, y0 + (r + 1) * t + pad)

    def tiles_over(pts):
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        c0, c1 = max(0, int((min(xs) - x0) // t)), min(cols - 1, int((max(xs) - x0) // t))
        r0, r1 = max(0, int((min(ys) - y0) // t)), min(rows - 1, int((max(ys) - y0) // t))
        return [(c, r) for c in range(c0, c1 + 1) for r in range(r0, r1 + 1)]

    def place(el, ref):
        tags = el.get("tags", {})
        if "building" in tags:
            if ref in campus_ids or not drawn_building(tags):
                return
            rs = [r for r in rings(el, proj) if len(r) > 2]
            if not rs or max(area_centroid(r)[2] for r in rs) < 25:  # sheds and kiosks are noise
                return
            # A building goes whole into the tile with its middle (its neighbours' tiles are loaded with it).
            bx, by, _ = area_centroid(max(rs, key=lambda r: area_centroid(r)[2]))
            c, r = int((bx - x0) // t), int((by - y0) // t)
            layer = "eth" if eth_code(tags) or uzh_code(tags) else "other"
            if zone.dist(bx, by) > fade_end(layer, ref):
                return
            if 0 <= c < cols and 0 <= r < rows:
                for ring in rs:
                    add((c, r), layer, ring)
            return
        layer = background_layer(tags)
        if not layer:
            return
        tol = COARSE_M.get(layer, SIMPLIFY_M)
        tram = tags.get("railway") in ("tram", "light_rail")
        end = fade_end("tram" if tram else layer, ref)
        rs = [ring for ring in rings(el, proj) if len(ring) >= 2]
        if layer in CLOSED_LAYERS:
            # Whole or not at all. Big green and water (the overview has them too) as long as any of it is in; parks
            # and squares by their middle, so they thin out.
            big = layer == "water" or max((area_centroid(r)[2] for r in rs if len(r) > 2), default=0) >= OVERVIEW_MIN_GREEN_M2
            if big:
                if all(zone.dist(x, y) > end for ring in rs for x, y in ring[::4] + ring[-1:]):
                    return
            elif not rs or zone.dist(*area_centroid(max(rs, key=lambda r: area_centroid(r)[2]))[:2]) > end:
                return
        else:
            rs = [piece for ring in rs for piece in zone.trim(ring, end)]
        for ring in rs:
            ring = simplify(ring, tol)
            for c, r in tiles_over(ring):
                if layer in CLOSED_LAYERS:
                    piece = clip_ring(ring, tile_box(c, r, 0.5))  # a hair over the edge: no seams
                    if piece:
                        add((c, r), layer, piece)
                else:
                    for piece in clip_line(ring, tile_box(c, r, 1)):
                        add((c, r), layer, piece)

    seen = set()
    for cy in range(math.ceil((y1 - y0) / REGION_CHUNK_M)):
        for cx in range(math.ceil((x1 - x0) / REGION_CHUNK_M)):
            ya, yb = y0 + cy * REGION_CHUNK_M, min(y1, y0 + (cy + 1) * REGION_CHUNK_M)
            xa, xb = x0 + cx * REGION_CHUNK_M, min(x1, x0 + (cx + 1) * REGION_CHUNK_M)
            (n, w), (s_, e) = to_latlon(proj, xa, ya), to_latlon(proj, xb, yb)
            key = f"osm_region_{REGION_CHUNK_M}_{cx}_{cy}_{x0}_{y0}"
            cached = cache and (cache / f"{key}.json").exists()
            print(f"  chunk {cx},{cy}{' (cached)' if cached else ''}", flush=True)
            els = overpass([round(v, 6) for v in (s_, w, n, e)], cache, key)
            if not cached:
                time.sleep(3)  # be kind to Overpass
            for el in els:
                ref = f"{el['type']}/{el['id']}"
                if ref in seen:
                    continue
                seen.add(ref)
                place(el, ref)
            print(f"    {len(els)} elements, {len(seen)} so far", flush=True)

    out = ROOT / "static" / "map" / "region"
    if out.exists():
        for old in out.glob("*.json"):
            old.unlink()
    out.mkdir(parents=True, exist_ok=True)
    for c in range(cols):
        for r in range(rows):
            piece = clip_ring(ground, tile_box(c, r, 0.5))
            if piece and (c, r) in tiles:
                add((c, r), "ground", piece)
    names, total, biggest = [], 0, (0, "")
    for (c, r), layers in sorted(tiles.items()):
        data = {k: d_attr(layers[k], k in CLOSED_LAYERS or k == "ground", COARSE_M.get(k, SIMPLIFY_M), digits=0)
                for k in ("ground", "green", "water", "river", "plaza", "service", "minor", "major", "foot", "rail", "funicular", "other", "eth")
                if k in layers}
        data = {k: v for k, v in data.items() if v}
        if not data:
            continue
        name = f"{c}_{r}"
        text = json.dumps({"layers": data}, separators=(",", ":"))
        (out / f"{name}.json").write_text(text)
        names.append(name)
        total += len(text)
        biggest = max(biggest, (len(text), name))
    index = {
        "origin": [proj.lat0, proj.lon0],
        "bounds": [x0, y0, x1, y1],
        "tile": t,
        "tiles": names,
        "attribution": "© OpenStreetMap contributors",
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"  {len(names)} tiles of {cols} x {rows}, {total // 1024} KB in all, biggest {biggest[1]} "
          f"({biggest[0] // 1024} KB) -> {out.relative_to(ROOT)}")
    return proj, [x0, y0, x1, y1]


def build_overview(proj, bounds, cache):
    """The land around the campuses, light (see the module docs), in the region's metres and over its area."""
    print("overview:")
    x0, y0, x1, y1 = bounds
    (n, w), (s, e) = to_latlon(proj, x0, y0), to_latlon(proj, x1, y1)
    key = f"osm_overview_{x0}_{y0}_{x1}_{y1}"
    if cache and (cache / f"{key}.json").exists():
        els = json.loads((cache / f"{key}.json").read_text())["elements"]
    else:
        b = f"{s},{w},{n},{e}"
        query = f"""[out:json][timeout:180];(
          way["highway"~"^({OVERVIEW_ROADS})$"]({b});
          way["railway"="rail"][!"service"]({b});
          way["waterway"="river"]({b});
          way["natural"="water"]({b}); relation["natural"="water"]({b});
          way["landuse"="forest"]({b}); relation["landuse"="forest"]({b});
          way["natural"="wood"]({b}); relation["natural"="wood"]({b});
        );out geom;"""
        els = overpass_query(query, cache, key)
    layers = {k: [] for k in ("green", "water", "river", "major", "rail")}
    for el in els:
        t = el.get("tags", {})
        if t.get("tunnel") in ("yes", "building_passage") or t.get("layer", "0").startswith("-"):
            continue
        rs = rings(el, proj)
        if "highway" in t:
            layers["major"].append(rs)
        elif "railway" in t:
            layers["rail"].append(rs)
        elif t.get("waterway") == "river":
            layers["river"].append(rs)
        elif t.get("natural") == "water":
            layers["water"].append(rs)
        elif max((area_centroid(r)[2] for r in rs if len(r) > 2), default=0) >= OVERVIEW_MIN_GREEN_M2:
            layers["green"].append(rs)

    box = (x0 - 50, y0 - 50, x1 + 50, y1 + 50)
    tolerance = {"green": 8, "water": 6, "river": 4, "major": 4, "rail": 4}
    out = {}
    for k, v in layers.items():
        closed = k in ("green", "water")
        pieces = []
        for rs in v:
            for r in rs:
                if len(r) < 2:
                    continue
                r = simplify(r, tolerance[k])
                if closed:
                    p = clip_ring(r, box)
                    if p:
                        pieces.append(p)
                else:
                    pieces += clip_line(r, box)
        out[k] = d_attr(pieces, closed, tolerance[k], digits=0)
    doc = {
        "origin": [proj.lat0, proj.lon0],
        "bounds": bounds,
        "layers": out,
        "attribution": "© OpenStreetMap contributors",
    }
    path = ROOT / "static" / "map" / "overview.json"
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text)
    print(f"  {x1 - x0} x {y1 - y0} m, {len(text) // 1024} KB -> {path.relative_to(ROOT)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache", type=Path, help="keep Overpass answers here and reuse them")
    ap.add_argument("areas", nargs="*", help="campus codes, or region (the tiles and the overview; builds every "
                                              "campus first). Default: everything")
    args = ap.parse_args()
    campuses = {k: v for k, v in json.loads((ROOT / "data" / "map" / "campuses.json").read_text()).items()
                if not k.startswith("_")}
    wanted = args.areas or [*campuses, "region"]
    region = "region" in wanted
    docs, campus_ids = {}, set()
    for area in campuses if region else [a for a in wanted if a != "region"]:
        doc, ids = build(area, campuses[area], args.cache)
        docs[area] = doc
        campus_ids |= ids
    if region:
        proj, bounds = build_region(docs, campus_ids, args.cache)
        build_overview(proj, bounds, args.cache)


if __name__ == "__main__":
    main()
