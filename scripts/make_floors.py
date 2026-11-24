#!/usr/bin/env python3
"""Build a building's floor plans for the map's floor view (static/map/floors/<building>.json) from ETH's plan PDFs.

Run by hand whenever a plan changes:  python3 scripts/make_floors.py HG [--draft]
Needs PyMuPDF and OpenCV (pip install -r requirements-floors.txt). The outputs are committed; CI doesn't run this.

Input:
- assets/eth-plans/<campus>/<building>/<building>_<level>_VF_<yyyymmdd>.pdf, one per level, from plan.ethz.ch (ETH
  login; not in git). The campus folder (zentrum, hoenggerberg) is only for sorting. The newest file per level is used.
- data/floors/<building>.json, written by hand. Coordinates on the plan are PDF points on the page as shown (rotation
  applied), origin top left; the debug images have a grid in them.
  - control: [[[x, y], <vertex index in the building's OSM outline (static/map/<area>.json)>], ...], 3 or more points
    pairing plan corners with outline vertices (or with [x, y] in campus metres, for a feature of a building fitted
    already). A similarity transform (scale, rotation, shift) is fitted to them; every point must fit within 1 m, and
    the scale must agree with the plan's scale bar. Given for the building (all of HG's sheets are drawn at the same
    place) or per level. `--fit` only fits and writes build/floors/<building>_<level>_fit.png: the plan with the
    outline drawn through the fit and its vertices numbered (without control points, the outline on its own).
  - scale_bar_m: the length of the plan's scale bar in metres (default 25; MM's plans have 30).
  - levels: bottom to top.
  - floors.<level>:
    - seeds: {key: [x, y]}, a point inside each region shown: an ETH room by its path ("HG E 3", as the
      Worker names rooms), a study space ("HGE30.7", as in data/overrides.json) or a place
      ("place:<Cookpit facility id>"). A place inside a study space names that space instead of a point
      ("place:2": "HGE30.7"); it's written as {"space": "HGE30.7"}, without a shape of its own. Places are written
      under the Worker's id for them ("F2"). A study space that is a mensa or cafeteria (ETH's room type 3300, as
      the Worker sorts them: Mensa Polyterrasse, "MMB79") is written as a place too, under its own id.
    - shapes: {key: [[x, y], ...]}, a room drawn as this polygon instead of a traced region (a plain rectangle where
      the traced shape takes in furniture or leaks, a lecture hall's shell). Used instead of a seed.
    - parts: {key: {"of": key, "name": "..."}}, a seed that is a further shape of another one (Zweistein next to
      Einstein, both "MMC81" for ETH and Cookpit). It's written with "of" and "name", and shows the other's state.
    - names: {key: "..."}, a name shown instead of ETH's or Cookpit's ("MMC81": "Einstein").
    - links: [{"to": "HG", "at": [x, y]}], where the level connects to another building with floor plans, on the same
      level or on "level" when the two name their floors differently ({"to": "LEE", "level": "F", ...} from CLA D).
      The floor view shows a button there that switches to that building.
    - cuts: [[[x1, y1], [x2, y2], ...], ...], extra wall lines (or polylines) where a region leaks through an open
      door, an archway or glass, or where a room is drawn only with thin lines.
    - fill: keys of regions whose holes (columns, pillars) are filled in.
    - outside: [[x, y], ...], points in regions that aren't part of the floor (ground beside the basement, roof,
      voids over the levels below).
    - clip: [[[x, y], ...], ...], the floor's outline on the plan (rings), used instead of the OSM outline where that
      is the roof and not the floor (GLC's rooms under ETA's overhanging hall). Also given for the whole building.
    - clip_add: [[[x, y], ...], ...], rings added to the clip area (parts of a basement beyond the OSM outline).
  - entrances: {level: [[x, y, "main" | "side"], ...]}, the building's entrances, drawn as arrows pointing in (at
    right angles to the nearest edge of the OSM outline). Classified by hand on build/floors/<building>_entrances.html,
    which shows the doors in the outer wall as candidates and gives this whole value to paste in.

How a floor is made: the plan's walls are its black fills (doors, windows, seating, stairs and furniture are thin
strokes, room numbers are outlines). Window lines along the outer wall are added as walls, each door is closed with
its leaf (doors are quarter circles around the hinge), gaps up to GAP_M are closed (only to find the regions), and
everything is clipped to the building's OSM outline, shrunk a little so that its edge runs inside the outer wall (that drops detail drawings placed beside the building, and outdoor arcades; rooms don't connect through
their windows). The free areas left are the regions: each seed picks one; regions without a seed become one neutral
"other" shape, except those marked `outside`. The floor's outline is all regions and walls together.

- data/floors/levels.json, by hand: per building, `ground` (the level at street level) and `order` (its levels, as
  `levels` above). Copied into the index for switching buildings on the matching level (static/lib.js matchLevel).

- data/floors/edits/<building>.json, from the map's edit mode (/?edit, written by scripts/apply_edits.py): shapes,
  entrances, stairs and lifts per level, applied on top of the trace.

Output: static/map/floors/<building>.json (paths in the campus map's metres) and static/map/floors/index.json (which
buildings have floor plans, per area, and under `levels` each one's ground level and level order). A level with nothing on frooms, no link and no entrance is left out. A debug
image per level and the page to classify entrances go to build/floors/ (git-ignored).
"""

import argparse
import base64
import json
import math
import re
import sys
from pathlib import Path

import cv2
import fitz  # PyMuPDF
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PX_PER_M = 20  # rendering resolution
GAP_M = 0.9  # wall gaps up to this wide are closed (to find the regions)
DOOR_R_M = (0.4, 1.6)  # door swings (quarter circles) with a radius in this range are doors
WINDOW_BAND_M = 1.5  # thin strokes this close to the outline's edge are windows and count as walls
CLIP_INSET_M = 0.3  # the OSM outline is shrunk by this much before clipping, so its edge runs inside the outer wall
CUT_M = 0.25  # width of a cut
SIMPLIFY_M = 0.15
OTHER_SIMPLIFY_M = 0.25  # the neutral background shape is simplified more
MIN_HOLE_M2 = 2.0
MIN_REGION_M2 = 1.0  # smaller free areas are noise (gaps inside walls)
ROOM_M2 = (4, 1500)  # a shown region outside this range is a leak or a seed in the wrong place
CONTROL_TOL_M = 1.0
SCALE_TOL = 0.02
MAX_KB = 250
ROOM_TYPES = {"3430", "3420"}  # lecture halls, seminar rooms (as in make_map.py)
MENSA_SPACE_TYPE = "3300"  # a study space of this type is a mensa or cafeteria (worker/config.ts SPACE_CATEGORIES)
ENTRANCE_NEAR_M = 2.0  # a door this close to the OSM outline's edge is a candidate entrance
ENTRANCE_MERGE_M = 3.0  # candidates closer than this are one (double doors)


class Fail(Exception):
    pass


# --- geometry ---------------------------------------------------------------------------------------------------

def outline_rings(d):
    """Rings of an SVG path made of M ... Z parts with absolute coordinates (static/map/*.json)."""
    rings = []
    for part in re.findall(r"M([^MZ]+)Z?", d):
        nums = [float(v) for v in part.split()]
        rings.append(list(zip(nums[0::2], nums[1::2])))
    return rings


def fit_similarity(src, dst):
    """Least-squares z_dst = a * z_src + b over complex numbers: scale, rotation and shift, no shear or mirroring."""
    zs = np.array([complex(*p) for p in src])
    zd = np.array([complex(*p) for p in dst])
    A = np.stack([zs, np.ones_like(zs)], 1)
    (a, b), *_ = np.linalg.lstsq(A, zd, rcond=None)
    resid = np.abs(A @ np.array([a, b]) - zd)
    return a, b, resid


def simplify(pts, tol):
    """Douglas-Peucker (as in make_map.py), iterative so long contours don't hit the recursion limit."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        (x1, y1), (x2, y2) = pts[i0], pts[i1]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        best, idx = 0.0, 0
        for i in range(i0 + 1, i1):
            px, py = pts[i]
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm if norm else math.hypot(px - x1, py - y1)
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(i0, idx), (idx, i1)]
    return [p for p, k in zip(pts, keep) if k]


def nearest_edge(rings, p):
    """Distance from p (complex) to the closest edge of the rings, the closest point on it and the edge's direction."""
    best = (math.inf, None, None)
    for r in rings:
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            a, d = complex(x1, y1), complex(x2 - x1, y2 - y1)
            if not d:
                continue
            t = min(1, max(0, ((p - a) * d.conjugate()).real / abs(d) ** 2))
            q = a + t * d
            if abs(p - q) < best[0]:
                best = (abs(p - q), q, d / abs(d))
    return best


def inside(rings, p):
    """Whether p (complex) is inside the rings (even-odd)."""
    n = 0
    for r in rings:
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            if (y1 > p.imag) != (y2 > p.imag) and p.real < x1 + (p.imag - y1) * (x2 - x1) / (y2 - y1):
                n += 1
    return n % 2 == 1


def inward(rings, p):
    """The direction into the building at p (degrees, clockwise from east as the map is drawn: y points down), at right
    angles to the closest edge of its outline."""
    _, q, d = nearest_edge(rings, p)
    n = d * 1j
    if not inside(rings, q + n * 0.5):
        n = -n
    return round(math.degrees(math.atan2(n.imag, n.real)))


def ring_d(ring):
    """A closed ring as SVG path data in decimetres."""
    coords = [(round(x, 1), round(y, 1)) for x, y in ring]
    coords = [c for i, c in enumerate(coords) if i == 0 or c != coords[i - 1]]
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords.pop()
    if len(coords) < 3:
        return ""
    return "M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in coords) + "Z"


# --- the plan ---------------------------------------------------------------------------------------------------

def plan_dir(building):
    """The building's folder of plans, in whichever campus folder it is."""
    dirs = sorted(d for d in (ROOT / "assets" / "eth-plans").glob(f"*/{building}") if d.is_dir())
    if len(dirs) > 1:
        raise Fail(f"plans for {building} in more than one place: {', '.join(str(d.relative_to(ROOT)) for d in dirs)}")
    return dirs[0] if dirs else None


def newest_pdfs(building):
    out = {}
    folder = plan_dir(building)
    if folder is None:
        raise Fail(f"no folder assets/eth-plans/<campus>/{building}/")
    for f in sorted(folder.glob(f"{building}_*_VF_*.pdf")):
        m = re.match(rf"{building}_([A-Z]+)_VF_(\d{{8}})\.pdf$", f.name)
        if m and (m[1] not in out or m[2] > out[m[1]][0]):
            out[m[1]] = (m[2], f)
    return {k: v[1] for k, v in out.items()}


def scale_bar(page, metres=25):
    """Points per metre from the scale bar (0 to `metres` m), or None. The bar is a horizontal line with evenly spaced
    long ticks (vertical strokes of one length, 6-25 pt) hanging from it, the first and last at its ends, and shorter
    ticks between the first two (HG: six long ticks of 12.6 pt for 0-25 m; MM: four of 11.2 pt for 0-30 m; CAB: five
    of 17.2 pt for 0-20 m; CLA: five of 8.1 pt with short ones of 5.5 pt; IFW: three of 14.2 pt for 0-10 m)."""
    M = page.rotation_matrix
    ticks, lines = [], []
    for d in page.get_drawings():
        if d["type"] != "s":
            continue
        for it in d["items"]:
            if it[0] == "l":
                a, b = it[1] * M, it[2] * M
                if abs(a.x - b.x) < 0.05 and 2 < abs(a.y - b.y) < 25:
                    ticks.append((round(min(a.y, b.y), 1), abs(a.y - b.y), a.x))
                elif abs(a.y - b.y) < 0.05 and abs(a.x - b.x) > 5:
                    lines.append((a.y, min(a.x, b.x), max(a.x, b.x)))

    def bar_along(y, x0, x1):  # horizontal strokes on row y cover x0 to x1 (the bar may be drawn in pieces, their y
        # a hair apart)
        reach = x0
        for a, b in sorted(ln[1:] for ln in lines if abs(ln[0] - y) < 0.2):
            if a <= reach + 0.2:
                reach = max(reach, b)
        return reach >= x1 - 0.2

    rows = {}
    for y, length, x in ticks:
        if length > 6:
            rows.setdefault((y, round(length, 1)), set()).add(round(x, 2))
    found = []  # the longest one is the bar (part of a bar can pass as one: MM's 0-20 m of 0-30 m)
    for (y, length), xs in rows.items():
        xs = sorted(xs)
        if len(xs) < 3:
            continue
        gaps = [b - a for a, b in zip(xs, xs[1:])]
        short = [x for ty, ln, x in ticks if ty == y and ln < length * 0.75 and xs[0] < x < xs[1]]
        if min(gaps) > 10 and max(gaps) - min(gaps) < 0.2 and len(short) >= 3 \
                and bar_along(y, xs[0], xs[-1]):
            found.append(xs[-1] - xs[0])
    return max(found) / metres if found else None


def render_layers(page, zoom):
    """The page's fills (walls) rendered, its strokes as line segments and its curves (P0..P3), in points on the page as
    shown, and the whole page rendered."""
    M = page.rotation_matrix
    doc = fitz.open()
    p = doc.new_page(width=page.rect.width, height=page.rect.height)
    shape = p.new_shape()
    thin, curves = [], []
    for d in page.get_drawings():
        items = d["items"]
        if d["type"] == "f":
            for it in items:
                if it[0] == "l":
                    shape.draw_line(it[1] * M, it[2] * M)
                elif it[0] == "c":
                    shape.draw_bezier(it[1] * M, it[2] * M, it[3] * M, it[4] * M)
                elif it[0] == "re":
                    shape.draw_quad(it[1].quad * M)
                elif it[0] == "qu":
                    shape.draw_quad(it[1] * M)
            shape.finish(fill=(0, 0, 0), color=None, even_odd=d.get("even_odd", False), closePath=True)
        elif d["type"] == "s":
            for it in items:
                if it[0] == "l":
                    thin.append((it[1] * M, it[2] * M))
                elif it[0] == "c":
                    thin.append((it[1] * M, it[4] * M))
                    curves.append([complex(*(q * M)) for q in it[1:5]])
                elif it[0] in ("re", "qu"):
                    q = (it[1].quad if it[0] == "re" else it[1]) * M
                    corners = [q.ul, q.ur, q.lr, q.ll]
                    thin += [(corners[k], corners[(k + 1) % 4]) for k in range(4)]
    shape.commit()
    pm = p.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    walls = (np.frombuffer(pm.samples, np.uint8).reshape(pm.h, pm.w) < 128).astype(np.uint8)
    full = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    plan = np.frombuffer(full.samples, np.uint8).reshape(full.h, full.w).copy()
    return walls, thin, curves, plan


def door_leaves(curves, pt_per_m):
    """Doors are drawn as a quarter circle around the hinge, from the open leaf's tip to the closed leaf's tip. Gives
    (hinge, tip, tip) per door: the closed leaf is the hinge to one of the tips (which one depends on the walls)."""
    out = []
    lo, hi = DOOR_R_M[0] * pt_per_m, DOOR_R_M[1] * pt_per_m
    for p0, p1, p2, p3 in curves:
        chord = p3 - p0
        if not lo * 1.3 < abs(chord) < hi * 1.5:
            continue
        mid = (p0 + p3) / 2
        perp = chord * 1j / 2
        ctrl = (p1 + p2) / 2
        h = max((mid + perp, mid - perp), key=lambda c: abs(c - ctrl))  # the centre is away from the bulge
        r = abs(p0 - h)
        on_arc = 0.125 * p0 + 0.375 * p1 + 0.375 * p2 + 0.125 * p3  # the curve at t = 0.5
        if lo <= r <= hi and abs(abs(on_arc - h) / r - 1) < 0.08:
            out.append((h, p0, p3))
    return out


def disk(r_px):
    r = max(1, int(round(r_px)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


# --- one level --------------------------------------------------------------------------------------------------

class Level:
    def __init__(self, building, level, pdf, conf, osm_rings, to_m, pt_per_m):
        self.building, self.level, self.conf = building, level, conf
        self.zoom = PX_PER_M / pt_per_m  # px per pt
        page = fitz.open(pdf)[0]
        walls, thin, curves, self.plan = render_layers(page, self.zoom)
        h, w = walls.shape
        z = self.zoom
        px = PX_PER_M

        # The building's OSM outline on the plan (or the outline drawn by hand, `clip`), and the clip area around it
        self.to_m = to_m
        from_m = lambda x, y: (lambda c: (c.real * z, c.imag * z))(to_m.inverse(complex(x, y)))
        if conf.get("clip"):
            osm_rings = [[(lambda c: (c.real, c.imag))(to_m(complex(*p))) for p in ring] for ring in conf["clip"]]
        osm = np.zeros((h, w), np.uint8)
        polys = [np.array([from_m(x, y) for x, y in r], np.int32) for r in osm_rings]
        cv2.fillPoly(osm, polys, 1)
        for ring in conf.get("clip_add", []):  # each on its own, so overlaps add up (fillPoly alternates them)
            add = np.zeros((h, w), np.uint8)
            cv2.fillPoly(add, [(np.array(ring) * z).astype(np.int32)], 1)
            osm |= add
        clip = cv2.erode(osm, disk(CLIP_INSET_M * px))
        edge = np.zeros((h, w), np.uint8)
        cv2.polylines(edge, polys, True, 1, 1)
        near_edge = cv2.dilate(edge, disk(WINDOW_BAND_M * px))

        # Windows: thin strokes close to the outline's edge
        win = np.zeros((h, w), np.uint8)
        for a, b in thin:
            pa, pb = (int(a.x * z), int(a.y * z)), (int(b.x * z), int(b.y * z))
            if all(0 <= p[0] < w and 0 <= p[1] < h and near_edge[p[1], p[0]] for p in (pa, pb)):
                cv2.line(win, pa, pb, 1, 2)
        walls = walls | win
        # Doors: close each with its leaf, from the hinge to the tip next to a wall
        fat = cv2.dilate(walls, disk(0.3 * px))
        on_wall = lambda q: 0 <= q[0] < w and 0 <= q[1] < h and fat[q[1], q[0]]
        self.leaves = []
        doors = door_leaves(curves, pt_per_m)
        # Candidate entrances (for build/floors/<building>_entrances.html): doors close to the outline's edge
        self.rings = osm_rings
        self.candidates = []
        for hinge, _, _ in doors:
            m = to_m(hinge)
            if nearest_edge(osm_rings, m)[0] <= ENTRANCE_NEAR_M and \
                    all(abs(m - to_m(complex(*c))) >= ENTRANCE_MERGE_M for c in self.candidates):
                self.candidates.append([round(hinge.real, 1), round(hinge.imag, 1)])
        for hinge, t1, t2 in doors:
            hp = (int(hinge.real * z), int(hinge.imag * z))
            tips = [(int(t.real * z), int(t.imag * z)) for t in (t1, t2)]
            closed = [t for t in tips if on_wall(t)] or tips
            for t in closed:
                cv2.line(walls, hp, t, 1, 3)
                self.leaves.append((hp, t))
        for cut in conf.get("cuts", []):
            cv2.polylines(walls, [(np.array(cut) * z).astype(np.int32)], False, 1, max(1, int(CUT_M * px)))
        self.walls = walls & clip
        # Regions are found with the gaps closed, then grown back into the free space next to them, so that room
        # corners stay sharp and a closed gap is split between the rooms on either side
        r = GAP_M / 2 * px
        closed = cv2.erode(cv2.dilate(walls, disk(r)), disk(r))
        free = ((1 - closed) & clip).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
        open_ = ((1 - walls) & clip).astype(bool)
        grown = lab.astype(np.float32)
        cross = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        for _ in range(int(r) + 2):
            more = cv2.dilate(grown, cross)
            todo = open_ & (grown == 0)
            grown[todo] = more[todo]
        lab = grown.astype(np.int32)
        stats[:, cv2.CC_STAT_AREA] = np.bincount(lab.ravel(), minlength=n)[:n]
        self.lab = lab
        min_px = MIN_REGION_M2 * px * px
        outside = {int(lab[int(y * z), int(x * z)]) for x, y in conf.get("outside", [])} - {0}
        self.regions = {i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_px and i not in outside}
        self.dropped = {i for i in range(1, n) if i not in self.regions and stats[i, cv2.CC_STAT_AREA] >= min_px}
        self.area_m2 = {i: stats[i, cv2.CC_STAT_AREA] / px / px for i in range(n)}

        # Seeds
        self.seed_of = {}
        self.errors = []
        self.shares = {}  # key -> the seed whose region it shares
        for key, at in conf.get("seeds", {}).items():
            if isinstance(at, str):
                if at not in conf["seeds"] or isinstance(conf["seeds"][at], str):
                    self.errors.append(f"{level}: {key} shares the region of {at}, which has no point of its own")
                else:
                    self.shares[key] = at
                continue
            x, y = at
            xi, yi = int(x * z), int(y * z)
            i = int(lab[yi, xi]) if 0 <= xi < w and 0 <= yi < h else 0
            if i not in self.regions:
                what = "a wall" if i == 0 else "an area outside the building" if i in self.dropped or i in outside \
                    else "a gap"
                self.errors.append(f"{level}: seed {key} at {x}, {y} is in {what}")
                continue
            if i in self.seed_of.values():
                other = next(k for k, v in self.seed_of.items() if v == i)
                self.errors.append(f"{level}: {key} and {other} are in the same region (a leak: add a cut)")
                continue
            self.seed_of[key] = i
            a = self.area_m2[i]
            if not ROOM_M2[0] <= a <= ROOM_M2[1]:
                self.errors.append(f"{level}: {key} is {a:.0f} m², outside {ROOM_M2[0]}-{ROOM_M2[1]} (a leak?)")

        # Shapes given as polygons (plan points) instead of traced regions
        self.shapes = {}
        for key, ring in conf.get("shapes", {}).items():
            m = np.zeros((h, w), np.uint8)
            cv2.fillPoly(m, [(np.array(ring) * z).astype(np.int32)], 1)
            self.shapes[key] = m
            if key in self.seed_of or key in self.shares:
                self.errors.append(f"{level}: {key} has a seed and a shape")
            a = m.sum() / px / px
            if not ROOM_M2[0] <= a <= ROOM_M2[1]:
                self.errors.append(f"{level}: shape {key} is {a:.0f} m², outside {ROOM_M2[0]}-{ROOM_M2[1]}")

    def mask(self, i, fill_holes):
        m = (self.lab == i).astype(np.uint8)
        if fill_holes:
            cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(m, cs, -1, 1, cv2.FILLED)
        return m

    def to_path(self, m, tol=SIMPLIFY_M):
        """Mask to SVG path data in campus metres (holes as extra rings: drawn with fill-rule evenodd). Parts under
        MIN_REGION_M2 and holes under MIN_HOLE_M2 (columns, the insides of room numbers) are left out."""
        z = self.zoom
        cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        out = []
        for c, (_, _, _, parent) in zip(cs, hier[0] if hier is not None else []):
            if cv2.contourArea(c) < (MIN_HOLE_M2 if parent >= 0 else MIN_REGION_M2) * PX_PER_M ** 2:
                continue
            pts = [self.to_m(complex((x + 0.5) / z, (y + 0.5) / z)) for x, y in c[:, 0, :]]
            ring = simplify([(p.real, p.imag) for p in pts] + [(pts[0].real, pts[0].imag)], tol)
            out.append(ring_d(ring))
        return "".join(out)

    def label_at(self, m):
        dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        y, x = np.unravel_index(int(np.argmax(dt)), dt.shape)
        p = self.to_m(complex(x / self.zoom, y / self.zoom))
        return [round(p.real, 1), round(p.imag, 1)]

    def point_m(self, x, y):
        p = self.to_m(complex(x, y))
        return [round(p.real, 1), round(p.imag, 1)]

    def build(self, kinds, entrances):
        """The level's output. `kinds`: what each seed key is (required()); `entrances`: [[x, y, "main"|"side"], ...]."""
        fill = set(self.conf.get("fill", []))
        parts, names = self.conf.get("parts", {}), self.conf.get("names", {})
        out = {"level": self.level}
        shown = {"rooms": {}, "spaces": {}, "places": {}}
        masks = {}
        items = [(key, self.mask(i, key in fill)) for key, i in self.seed_of.items()] + list(self.shapes.items())
        for key, m in items:
            masks[key] = m
            entry = {"d": self.to_path(m), "at": self.label_at(m)}
            of = parts.get(key, {}).get("of")
            if of:
                entry["of"] = out_id(of)
            if parts.get(key, {}).get("name") or names.get(key):
                entry["name"] = parts.get(key, {}).get("name") or names[key]
            shown[group_of(of or key, kinds)][out_id(key)] = entry
        for key, at in self.shares.items():  # a place inside a study space (CafeBar in the HG Lobby)
            shown["places"][out_id(key)] = {"space": at}
        seeded = set(self.seed_of.values())
        other = np.isin(self.lab, [i for i in self.regions if i not in seeded]).astype(np.uint8)
        for m in self.shapes.values():
            other &= 1 - m
        kept = np.isin(self.lab, list(self.regions)).astype(np.uint8)
        for m in masks.values():
            kept |= m
        # Outline: regions and the walls next to them, small gaps closed, holes filled
        body = kept | (self.walls & cv2.dilate(kept, disk(1.0 * PX_PER_M)))
        body = cv2.morphologyEx(body, cv2.MORPH_CLOSE, disk(0.5 * PX_PER_M))
        cs, _ = cv2.findContours(body, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        body[:] = 0
        cv2.drawContours(body, [c for c in cs if cv2.contourArea(c) > 10 * PX_PER_M ** 2], -1, 1, cv2.FILLED)
        out["outline"] = self.to_path(body)
        out["other"] = self.to_path(other, OTHER_SIMPLIFY_M)
        out.update(shown)
        out["links"] = [{"to": ln["to"], "at": self.point_m(*ln["at"]), **({"level": ln["level"]} if "level" in ln else {})}
                        for ln in self.conf.get("links", [])]
        out["entrances"] = []
        for x, y, kind in entrances:
            at = self.point_m(x, y)
            out["entrances"].append({"at": at, "dir": inward(self.rings, complex(*at)), "main": kind == "main"})
        self.masks, self.other, self.body = masks, other, body
        return out

    def entrance_page_data(self):
        """The level for build/floors/<building>_entrances.html: the plan (scaled down), the OSM outline and the
        candidate entrances, in points on the plan."""
        h, w = self.plan.shape
        k = min(1.0, 2000 / w)
        ok, png = cv2.imencode(".png", cv2.resize(self.plan, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA))
        inv = lambda x, y: (lambda c: [round(c.real, 1), round(c.imag, 1)])(self.to_m.inverse(complex(x, y)))
        return {"level": self.level, "w": round(w / self.zoom, 1), "h": round(h / self.zoom, 1),
                "image": "data:image/png;base64," + base64.b64encode(png.tobytes()).decode(),
                "outline": [[inv(x, y) for x, y in r] for r in self.rings], "candidates": self.candidates}

    def debug_image(self, path, grid):
        z = self.zoom
        img = cv2.cvtColor(self.plan, cv2.COLOR_GRAY2BGR)
        img = (img * 0.55 + 255 * 0.45).astype(np.uint8)
        rng = np.random.default_rng(1)
        if grid:  # every region in its own colour, so seeds can be read off
            colors = rng.integers(60, 230, (self.lab.max() + 1, 3)).astype(np.uint8)
            sel = np.isin(self.lab, list(self.regions))
            img[sel] = (img[sel] * 0.4 + colors[self.lab[sel]] * 0.6).astype(np.uint8)
            dr = np.isin(self.lab, list(self.dropped))
            img[dr] = (img[dr] * 0.7 + np.array([200, 200, 255]) * 0.3).astype(np.uint8)
        else:
            img[self.other > 0] = (img[self.other > 0] * 0.6 + np.array([180, 180, 180]) * 0.4).astype(np.uint8)
            for key, m in self.masks.items():
                c = np.array((60, 170, 60) if " " in key else (230, 140, 40) if not key.startswith("place:")
                             else (40, 90, 230))
                sel = m > 0
                img[sel] = (img[sel] * 0.45 + c * 0.55).astype(np.uint8)
            cs, _ = cv2.findContours(self.body, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(img, cs, -1, (0, 0, 200), 2)
        for key, at in self.conf.get("seeds", {}).items():
            if isinstance(at, str):
                continue
            x, y = at
            p = (int(x * z), int(y * z))
            cv2.circle(img, p, 6, (0, 0, 255), -1)
            cv2.putText(img, key, (p[0] + 8, p[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 160), 2)
        if grid:
            for a, b in self.leaves:
                cv2.line(img, a, b, (0, 0, 230), 2)
        for cut in self.conf.get("cuts", []):
            cv2.polylines(img, [(np.array(cut) * z).astype(np.int32)], False, (255, 0, 255), 3)
        if grid:
            h, w = img.shape[:2]
            for v in range(0, int(max(w, h) / z), 10):
                c = (230, 200, 200) if v % 50 else (200, 120, 120)
                cv2.line(img, (int(v * z), 0), (int(v * z), h), c, 1)
                cv2.line(img, (0, int(v * z)), (w, int(v * z)), c, 1)
                if v % 50 == 0:
                    cv2.putText(img, str(v), (int(v * z) + 2, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (150, 0, 0), 2)
                    cv2.putText(img, str(v), (2, int(v * z) - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (150, 0, 0), 2)
        path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(path), img)


def out_id(key):
    """The id a seed key is written under: places by the Worker's id for them ("place:2" -> "F2")."""
    return f"F{key[6:]}" if key.startswith("place:") else key


def group_of(key, kinds):
    if key.startswith("place:") or kinds.get(key) == "place":
        return "places"
    return "rooms" if " " in key else "spaces"


class Transform:
    """Plan points (complex, pt) to campus metres (complex)."""

    def __init__(self, a, b):
        self.a, self.b = a, b

    def __call__(self, p):
        return self.a * p + self.b

    def inverse(self, m):
        return (m - self.b) / self.a


# --- checks -----------------------------------------------------------------------------------------------------

def space_level(title):
    """'HG E 20.0029' -> 'E'; galleries between two levels ('HG EO 27.1') are drawn on the lower one."""
    return title.split()[1][0]


def required(building):
    """Everything that must have a region: {level: {seed key: what}}."""
    need = {}
    for r in json.loads((ROOT / "data" / "rooms_snapshot.json").read_text()):
        if r["building"] == building and r["typecode"] in ROOM_TYPES:
            need.setdefault(r["floor"], {})[f"{r['building']} {r['floor']} {r['room']}"] = "room"  # as the Worker names it
    overrides = json.loads((ROOT / "data" / "overrides.json").read_text())
    for s in json.loads((ROOT / "data" / "spaces_snapshot.json").read_text()):
        a = s["attributes"]
        if a["building"] == building:
            sid = a["roomGlobalIdentifier"]
            if "merge_into" in overrides["spaces"].get(sid, {}):  # shown as part of another (a `parts` seed may draw it)
                continue
            category = overrides["spaces"].get(sid, {}).get("category") or \
                ("mensa" if a["roomType"]["code"] == MENSA_SPACE_TYPE else "open")
            need.setdefault(space_level(a["title"]), {})[sid] = "place" if category == "mensa" else "study space"
    eateries = json.loads((ROOT / "data" / "eateries_snapshot.json").read_text())["facility-array"]
    for e in eateries:
        o = overrides["eateries"].get(str(e["facility-id"]), {})
        if e["building"] == building and "space" not in o and not o.get("hidden") and "merge_into" not in o:
            need.setdefault(e["floor"], {})[f"place:{e['facility-id']}"] = e["facility-name"]
    return need


# --- the page to classify entrances ---------------------------------------------------------------------------

ENTRANCE_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrances: __B__</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; background: #f4f4f2; color: #222; }
  header { position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid #ccc; padding: 8px 16px; }
  header p { margin: 4px 0; }
  textarea { width: 100%; height: 7em; font: 12px ui-monospace, monospace; box-sizing: border-box; }
  nav a { margin-right: 10px; }
  section { padding: 12px 16px; }
  svg { width: 100%; height: auto; background: #fff; border: 1px solid #ccc; cursor: crosshair; }
  .cand { fill: rgba(0, 120, 255, .12); stroke: #07f; stroke-width: 1; cursor: pointer; }
  .main { fill: #d22; stroke: #fff; stroke-width: 1.5; cursor: pointer; }
  .side { fill: #f90; stroke: #fff; stroke-width: 1.5; cursor: pointer; }
  .outline { fill: none; stroke: #07f; stroke-width: .8; stroke-dasharray: 4 3; pointer-events: none; }
  .tag { font: bold 9px system-ui; fill: #fff; pointer-events: none; text-anchor: middle; dominant-baseline: central; }
</style></head><body>
<header>
  <p><b>__B__: entrances.</b> Click a blue circle (a door in the outer wall) to make it a <b style="color:#f90">side</b>
  entrance, again for <b style="color:#d22">main</b>, again to remove it. Shift-click anywhere to add one there.
  Then copy the value below into <code>"entrances"</code> in <code>data/floors/__B__.json</code> and run
  <code>python3 scripts/make_floors.py __B__</code>.</p>
  <nav id="nav"></nav>
  <textarea id="out" readonly></textarea>
  <button id="copy" type="button">Copy</button> <span id="copied"></span>
</header>
<main id="levels"></main>
<script>
const DATA = __DATA__;
const state = DATA.entrances;
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 6;
function output() {
  const lines = Object.keys(state).filter((lv) => state[lv].length).sort().map((lv) => `  "${lv}": ${JSON.stringify(state[lv])}`);
  document.getElementById("out").value = `{\\n${lines.join(",\\n")}\\n}`;
}
function cycle(lv, at) {
  const list = (state[lv] ??= []);
  const i = list.findIndex((e) => near(e, at));
  if (i < 0) list.push([at[0], at[1], "side"]);
  else if (list[i][2] === "side") list[i][2] = "main";
  else list.splice(i, 1);
  draw(lv);
  output();
}
function draw(lv) {
  const d = DATA.levels.find((l) => l.level === lv);
  const g = document.getElementById(`marks-${lv}`);
  g.replaceChildren();
  for (const c of d.candidates) {
    const e = svgEl("circle", { cx: c[0], cy: c[1], r: 7, class: "cand" });
    e.addEventListener("click", (ev) => { ev.stopPropagation(); cycle(lv, c); });
    g.append(e);
  }
  for (const en of state[lv] ?? []) {
    const r = en[2] === "main" ? 7 : 5;
    const e = svgEl("circle", { cx: en[0], cy: en[1], r, class: en[2] });
    e.addEventListener("click", (ev) => { ev.stopPropagation(); cycle(lv, en); });
    const t = svgEl("text", { x: en[0], y: en[1], class: "tag" });
    t.textContent = en[2] === "main" ? "M" : "S";
    g.append(e, t);
  }
}
for (const d of DATA.levels) {
  const a = document.createElement("a");
  a.href = `#level-${d.level}`;
  a.textContent = `Level ${d.level}`;
  document.getElementById("nav").append(a);
  const sec = document.createElement("section");
  sec.id = `level-${d.level}`;
  const h = document.createElement("h2");
  h.textContent = `Level ${d.level}`;
  const svg = svgEl("svg", { viewBox: `0 0 ${d.w} ${d.h}` });
  svg.append(svgEl("image", { href: d.image, x: 0, y: 0, width: d.w, height: d.h }));
  for (const r of d.outline) svg.append(svgEl("polygon", { points: r.map((p) => p.join(",")).join(" "), class: "outline" }));
  const g = svgEl("g", { id: `marks-${d.level}` });
  svg.append(g);
  svg.addEventListener("click", (ev) => {
    if (!ev.shiftKey) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
    cycle(d.level, [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]);
  });
  sec.append(h, svg);
  document.getElementById("levels").append(sec);
  draw(d.level);
}
document.getElementById("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.getElementById("out").value);
  document.getElementById("copied").textContent = "Copied";
});
output();
</script></body></html>
"""


def write_entrance_page(building, pages, entrances):
    """build/floors/<building>_entrances.html: click the candidate doors to classify the entrances (see the docstring)."""
    data = {"levels": pages, "entrances": entrances}
    page = ENTRANCE_PAGE.replace("__B__", building).replace("__DATA__", json.dumps(data, separators=(",", ":")))
    path = ROOT / "build" / "floors" / f"{building}_entrances.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page)
    print(f"  entrances page -> {path.relative_to(ROOT)}")


# --- the image to check the fit ---------------------------------------------------------------------------------

FIT_ZOOM = 2  # px per pt in build/floors/<building>_<level>_fit.png


def fit_image(path, page, rings, transform, control, verts):
    """build/floors/<building>_<level>_fit.png: the plan with the building's OSM outline drawn through the fitted
    transform (blue, every vertex numbered), the control points (green on the plan, a line to the vertex they're paired
    with) and a grid in plan points. Without a fit (no control points yet) the outline is drawn on its own in the top
    left corner, north up, to pick vertices from."""
    pm = page.get_pixmap(matrix=fitz.Matrix(FIT_ZOOM, FIT_ZOOM), colorspace=fitz.csGRAY)
    g = np.frombuffer(pm.samples, np.uint8).reshape(pm.h, pm.w)
    img = cv2.cvtColor((g * 0.6 + 255 * 0.4).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    for v in range(0, int(max(w, h) / FIT_ZOOM), 10):
        c = (235, 215, 215) if v % 50 else (200, 140, 140)
        cv2.line(img, (v * FIT_ZOOM, 0), (v * FIT_ZOOM, h), c, 1)
        cv2.line(img, (0, v * FIT_ZOOM), (w, v * FIT_ZOOM), c, 1)
        if v % 50 == 0:
            cv2.putText(img, str(v), (v * FIT_ZOOM + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (150, 0, 0), 1)
            cv2.putText(img, str(v), (2, v * FIT_ZOOM - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (150, 0, 0), 1)
    if transform is not None:
        to_px = lambda x, y: (lambda c: (int(c.real * FIT_ZOOM), int(c.imag * FIT_ZOOM)))(transform.inverse(complex(x, y)))
    else:
        xs = [x for r in rings for x, _ in r]
        ys = [y for r in rings for _, y in r]
        k = min(w, h) * 0.45 / max(max(xs) - min(xs), max(ys) - min(ys))
        to_px = lambda x, y: (int(30 + (x - min(xs)) * k), int(30 + (y - min(ys)) * k))
    for ri, r in enumerate(rings):
        pts = np.array([to_px(x, y) for x, y in r], np.int32)
        cv2.polylines(img, [pts], True, (230, 120, 0), 2)
        if ri == 0:
            for i, p in enumerate(pts):
                cv2.circle(img, tuple(int(v) for v in p), 4, (230, 120, 0), -1)
                cv2.putText(img, str(i), (int(p[0]) + 5, int(p[1]) - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 60, 0), 2)
    for p, i in control or []:
        q = (int(p[0] * FIT_ZOOM), int(p[1] * FIT_ZOOM))
        cv2.circle(img, q, 6, (0, 170, 0), 2)
        cv2.line(img, q, to_px(*control_target(i, verts)), (0, 170, 0), 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img)


def control_target(target, verts):
    """A control point's position in campus metres: a vertex of the OSM outline (its index), or [x, y] in metres (a
    feature of a building fitted already, read off its output)."""
    return tuple(target) if isinstance(target, list) else verts[target]


# --- main -------------------------------------------------------------------------------------------------------

def area_of(building):
    for f in sorted((ROOT / "static" / "map").glob("*.json")):
        if f.stem in ("overview", "pins"):
            continue
        data = json.loads(f.read_text())
        if building in data.get("buildings", {}):
            return f.stem, data["buildings"][building]
    raise Fail(f"{building} isn't on any campus map (static/map/*.json)")


def building_levels(b, conf):
    """{"ground": ..., "order": [...]} for static/map/floors/index.json, from data/floors/levels.json, checked against
    the building's levels and its main entrances (an entrance marked main is at street level)."""
    table = json.loads((ROOT / "data" / "floors" / "levels.json").read_text())
    ground = table["ground"].get(b)
    order = table["order"].get(b)
    if not ground or not order:
        raise Fail(f"{b} has no ground level or level order in data/floors/levels.json")
    if order != conf["levels"]:
        raise Fail(f"data/floors/levels.json's order for {b} ({order}) isn't its levels ({conf['levels']})")
    if len(ground) != 1 or ground not in "ABCDEFGHJKLMNOPQRSTUVWXYZ":  # it needn't have plans (CAB's E hasn't)
        raise Fail(f"{b}'s ground level {ground!r} isn't a level letter")
    main_at = sorted({lv for lv, ents in conf.get("entrances", {}).items() if any(e[2] == "main" for e in ents)})
    if main_at and ground not in main_at:
        raise Fail(f"{b}'s ground level is {ground}, but its main entrances are on {', '.join(main_at)}")
    return {"ground": ground, "order": order}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("building")
    ap.add_argument("--draft", action="store_true", help="report problems without failing, write no output")
    ap.add_argument("--level", help="only this level (implies --draft)")
    ap.add_argument("--fit", action="store_true", help="only fit the plans and write build/floors/<b>_<level>_fit.png")
    args = ap.parse_args()
    b = args.building
    draft = args.draft or bool(args.level) or args.fit
    conf = json.loads((ROOT / "data" / "floors" / f"{b}.json").read_text())
    area, outline = area_of(b)
    rings = outline_rings(outline["d"])
    verts = rings[0]
    pdfs = newest_pdfs(b)
    missing = [lv for lv in conf["levels"] if lv not in pdfs]
    if missing:
        raise Fail(f"no plan for level(s) {', '.join(missing)} in {plan_dir(b).relative_to(ROOT)}/")

    errors = []
    levels = []
    pages = []
    need = required(b)
    for lv in conf["levels"]:
        if args.level and lv != args.level:
            continue
        fconf = conf["floors"].get(lv, {})
        control = fconf.get("control") or conf.get("control")
        page = fitz.open(pdfs[lv])[0]
        fit_png = ROOT / "build" / "floors" / f"{b}_{lv}_fit.png"
        if not control or len(control) < 3:
            fit_image(fit_png, page, rings, None, None, verts)
            errors.append(f"{lv}: fewer than 3 control points (pick some on {fit_png.relative_to(ROOT)})")
            continue
        a, off, resid = fit_similarity([p for p, _ in control], [control_target(i, verts) for _, i in control])
        pt_per_m = 1 / abs(a)
        for (p, i), r in zip(control, resid):
            if r > CONTROL_TOL_M:
                errors.append(f"{lv}: control point {p} (outline vertex {i}) is off by {r:.1f} m")
        bar = scale_bar(page, conf.get("scale_bar_m", 25))
        if bar is None:
            errors.append(f"{lv}: no scale bar found")
        elif abs(pt_per_m / bar - 1) > SCALE_TOL:
            errors.append(f"{lv}: fitted scale {pt_per_m:.3f} pt/m, scale bar {bar:.3f}")
        fit_image(fit_png, page, rings, Transform(a, off), control, verts)
        if args.fit:
            print(f"  {lv}: fit {max(resid):.2f} m ({', '.join(f'{r:.2f}' for r in resid)}), rotation "
                  f"{math.degrees(np.angle(a)):.1f}°, {pt_per_m:.3f} pt/m, bar {bar and round(bar, 3)}")
            continue
        clip = fconf.get("clip") or conf.get("clip")
        clip_add = fconf.get("clip_add") or conf.get("clip_add") or []
        level = Level(b, lv, pdfs[lv], {**fconf, "clip": clip, "clip_add": clip_add}, rings, Transform(a, off), pt_per_m)
        errors += level.errors
        for ln in fconf.get("links", []):
            other = ROOT / "data" / "floors" / f"{ln['to']}.json"
            to_lv = ln.get("level", lv)
            if not other.exists() or to_lv not in json.loads(other.read_text())["levels"]:
                errors.append(f"{lv}: link from {b} {lv} to {ln['to']} {to_lv}, but {ln['to']} has no floor plan for "
                              f"level {to_lv}")
        kinds = {k: what for level_need in need.values() for k, what in level_need.items()}
        out = level.build(kinds, conf.get("entrances", {}).get(lv, []))
        pages.append(level.entrance_page_data())
        print(f"  {lv}: {pdfs[lv].name}, {len(level.seed_of)} regions shown, {len(level.regions)} in all, "
              f"fit {max(resid):.2f} m, rotation {math.degrees(np.angle(a)):.1f}°, {pt_per_m:.3f} pt/m")
        dbg = ROOT / "build" / "floors"
        level.debug_image(dbg / f"{b}_{lv}.png", grid=False)
        level.debug_image(dbg / f"{b}_{lv}_grid.png", grid=True)
        for key, what in need.get(lv, {}).items():
            if key not in level.seed_of and key not in level.shares and key not in level.shapes:
                errors.append(f"{lv}: no region for {what} {key}")
        levels.append(out)

    if args.fit:
        for e in errors:
            print("  !", e)
        return
    write_entrance_page(b, pages, conf.get("entrances", {}))
    known = {k for lv in need.values() for k in lv}
    for lv, f in conf["floors"].items():
        for key in [*f.get("seeds", {}), *f.get("shapes", {})]:
            of = f.get("parts", {}).get(key, {}).get("of")
            if (of or key) not in known:
                errors.append(f"{lv}: seed {key} isn't a room, study space or place of {b} (typo?)")
            if of and of not in f["seeds"]:
                errors.append(f"{lv}: {key} is a part of {of}, which has no seed on this level")
    for lv, ents in conf.get("entrances", {}).items():
        for e in ents:
            if len(e) != 3 or e[2] not in ("main", "side"):
                errors.append(f"{lv}: entrance {e} should be [x, y, \"main\" | \"side\"]")

    if draft:
        for e in errors:
            print("  !", e)
        return
    if errors:
        raise Fail("\n".join(errors))
    # A level with no room, study space or place on frooms isn't worth a button, unless it leads somewhere: a link to
    # another building or an entrance.
    empty = [lv["level"] for lv in levels if not any(lv[k] for k in ("rooms", "spaces", "places", "links", "entrances"))]
    if empty:
        print(f"  left out (nothing on frooms, no link or entrance): {', '.join(empty)}")
    levels = [lv for lv in levels if lv["level"] not in empty]
    data = {"building": b, "area": area, "levels": levels}
    # Raffaele's edits from the map's edit mode (data/floors/edits/<b>.json, scripts/apply_edits.py): corners moved,
    # entrances, stairs and lifts placed by hand, on top of the trace.
    from apply_edits import apply_floor_edits, kept_edits
    for note in apply_floor_edits(data, kept_edits(b)):
        print("  !", note)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_KB * 1024:
        for lv in levels:
            print(lv["level"], {k: len(json.dumps(v)) // 1024 for k, v in lv.items() if k != "level"})
        raise Fail(f"{b}.json is {len(text) // 1024} KB, over {MAX_KB} KB")
    out_dir = ROOT / "static" / "map" / "floors"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{b}.json").write_text(text + "\n")
    index_path = out_dir / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    index.setdefault(area, [])
    if b not in index[area]:
        index[area] = sorted(index[area] + [b])
    # Which level is at street level and the levels in order (data/floors/levels.json), for switching buildings.
    index["levels"] = {**index.get("levels", {}), b: building_levels(b, conf)}
    index["levels"] = dict(sorted(index["levels"].items()))
    index_path.write_text(json.dumps(index, separators=(",", ":")) + "\n")
    print(f"  {len(text) // 1024} KB -> {(out_dir / f'{b}.json').relative_to(ROOT)}")


if __name__ == "__main__":
    try:
        main()
    except Fail as e:
        print(f"make_floors: {e}", file=sys.stderr)
        sys.exit(1)
