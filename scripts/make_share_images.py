"""Pre-render the preview images for invite links: static/og/<bg>/<room>.jpg and static/og/<bg>/space-<id>.jpg,
one per room or study space and background, and the meal invites static/og/meal/<bg>/space-<id>-<meal>-<time>.jpg,
one per mensa, meal it serves, background and time: "now", every quarter hour of the meal, and without a time one per
day the invite can be for ("today", "tomorrow", "monday" … "sunday"), so the image never says another day than the text.

WhatsApp and other link unfurlers show og:image as a large card when it is about 1200x630. The Worker can't draw
images within the Workers Free CPU limit, so this runs before each deploy (npm run deploy). Images that are already
newer than their inputs are skipped.

Backgrounds and their text colours are listed in assets/share-backgrounds/backgrounds.json (rooms and spaces) and
meals.json (meal invites); the list order is the `bg` number in the links, so add new backgrounds at the end.
A background with "university": "UZH" is for UZH's rooms (and mensas) only, the others for ETH's; the app picks one of
the place's own university (static/og/backgrounds.json lists which are UZH's).

The mensas are those of data/overrides.json (`eateries` with kind "mensa"); their meal times come from Cookpit, ETH's
menu system, in one request (the earliest start and latest end of each meal over three weeks), or lunch 11:00-14:00
if that fails. UZH's mensas (data/uzh.json `mensas`) have their meal times there.

Run from the project root: python3 scripts/make_share_images.py [--force]
"""

import json
import os
import re
import ssl
import subprocess
import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BACKGROUNDS = ROOT / "assets" / "share-backgrounds"
FONT = ROOT / "static" / "fonts" / "Archivo.woff2"
OUT = ROOT / "static" / "og"
SNAPSHOT = ROOT / "data" / "rooms_snapshot.json"
SPACES_SNAPSHOT = ROOT / "data" / "spaces_snapshot.json"
UZH_ROOMS_SNAPSHOT = ROOT / "data" / "uzh_rooms_snapshot.json"
EATERIES_SNAPSHOT = ROOT / "data" / "eateries_snapshot.json"
OVERRIDES = json.loads((ROOT / "data" / "overrides.json").read_text())
UZH = json.loads((ROOT / "data" / "uzh.json").read_text())  # its `exclude` (titles that aren't teaching rooms), its mensas
# Our own names for some spaces (see worker/overrides.ts).
SPACE_OVERRIDES = OVERRIDES["spaces"]
# Must match COOKPIT_URL and COOKPIT_CLIENT in worker/config.ts.
COOKPIT = "https://idapps.ethz.ch/cookpit-pub-services/v1/weeklyrotas"
COOKPIT_CLIENT = "ethz-wcms"
DEFAULT_MEALS = {"lunch": ("11:00", "14:00")}
DINNER_FROM = "15:00"  # meal times starting before this are lunch (worker/menus.ts)

WIDTH, HEIGHT = 1200, 630
MAX_TEXT_WIDTH = 1000
MARK, DOT = "#1d2a5b", "#da291c"  # the wordmark and its red dot


def share_slug(room: str) -> str:
    """File name of a room's image, e.g. 'HG E 1.1' -> 'HG-E-1-1'. Must match shareSlug in worker/index.ts."""
    return re.sub(r"[^A-Za-z0-9]+", "-", room)


def space_slug(space_id: str) -> str:
    """File name of a study space's image, e.g. 'HGH30.1' -> 'space-HGH30-1'. Must match spaceSlug in worker/index.ts."""
    return f"space-{share_slug(space_id)}"


def from_kv(key: str, snapshot: Path) -> list:
    """The `raw` list stored under `key` in the live KV, or the bundled snapshot if wrangler can't reach it."""
    raw = None
    try:
        out = subprocess.run(
            ["npx", "wrangler", "kv", "key", "get", key, "--binding", "ROOMS", "--remote"],
            cwd=ROOT, capture_output=True, text=True, timeout=60, check=True,
        ).stdout
        raw = json.loads(out)["raw"]
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, TypeError) as e:
        print(f"Live {key} unavailable ({type(e).__name__}), using {snapshot.name}", file=sys.stderr)
    return raw or json.loads(snapshot.read_text())


def catalogue() -> list[str]:
    """Room paths from the live catalogue."""
    raw = from_kv("catalogue", SNAPSHOT)
    return sorted({f"{r['building']} {r['floor']} {r['room']}" for r in raw if r.get("area")})


# A UZH room title, e.g. 'KOL-F-101 (209 Plätze) **'; must match TITLE and SEATS in worker/uzh.ts.
UZH_TITLE = re.compile(r"^([A-Z][A-Z0-9]{2})-([A-Za-z0-9]{1,2})-([A-Za-z0-9.]+(?:/[A-Za-z0-9.]+)*)(?=\s|$)(.*)$")
UZH_SEATS = re.compile(r"\((?:min\.\s*\d+\s*/\s*max\.\s*)?(\d+)\s*(?:/[^)]*)?(Plätze|Sitzplätze|Personen)?")


def uzh_room_parts(room: str) -> list[str]:
    """The single rooms a combined room ('K.11/12') is made of. Must match roomParts in worker/uzh.ts."""
    head, *tail = room.split("/")
    prefix = head[: head.rfind(".") + 1] if "." in head else ""
    return [head, *(t if "." in t else prefix + t for t in tail)]


def uzh_catalogue() -> list[str]:
    """UZH's room codes ('KOL-F-101') from the live list, as the Worker lists them (parseUzhCatalogue in worker/uzh.ts)."""
    exclude = re.compile("|".join(re.escape(x) for x in UZH["exclude"]), re.I)
    parsed = []
    for r in from_kv("uzh_catalogue", UZH_ROOMS_SNAPSHOT):
        m = UZH_TITLE.match(r["title"].strip())
        if not m or exclude.search(r["title"]):
            continue
        seats = UZH_SEATS.search(m[4])
        if seats and seats[2] == "Personen":
            continue  # an event space
        parsed.append((m[1], m[2], m[3]))
    single = {f"{b}-{f}-{room}" for b, f, room in parsed if "/" not in room}
    return sorted({
        f"{b}-{f}-{room}" for b, f, room in parsed
        if "/" not in room or not any(f"{b}-{f}-{p}" in single for p in uzh_room_parts(room))
    })


def study_spaces() -> list[dict]:
    """Study spaces and mensas (id, name, room) from the live list."""
    spaces = []
    for item in from_kv("spaces", SPACES_SNAPSHOT):
        a = item.get("attributes") or {}
        if a.get("roomGlobalIdentifier") and a.get("title"):
            sid = a["roomGlobalIdentifier"]
            if SPACE_OVERRIDES.get(sid, {}).get("merge_into"):
                continue  # shown as part of another space
            name = SPACE_OVERRIDES.get(sid, {}).get("name") or a.get("description") or a["title"]
            spaces.append({"id": sid, "name": name, "room": a["title"]})
    return spaces


def mensas(spaces: list[dict]) -> list[dict]:
    """The mensas (id, name), as the Worker lists them (worker/menus.ts eateryPlaces)."""
    names = {s["id"]: s["name"] for s in spaces}
    try:
        facilities = from_kv("eateries", EATERIES_SNAPSHOT)
    except (OSError, ValueError):
        facilities = []
    if isinstance(facilities, dict):
        facilities = facilities.get("facility-array", [])
    facility_names = {str(f.get("facility-id")): f.get("facility-name") for f in facilities}
    out = []
    for fid, o in OVERRIDES["eateries"].items():
        if not fid.isdigit() or o.get("kind") != "mensa" or o.get("hidden") or o.get("merge_into"):
            continue
        sid = o.get("space") or f"F{fid}"
        name = o.get("name") or names.get(o.get("space")) or facility_names.get(fid)
        if name:
            out.append({"id": sid, "facility": int(fid), "name": name, "university": "ETH"})
    # UZH's mensas (worker/uzhmenus.ts), with their meal times.
    for m in UZH.get("mensas", []):
        meals = {x["meal"]: (x["from"], x["to"]) for x in m["meals"]}
        out.append({"id": m["id"], "facility": m["facility"], "name": m["name"], "meals": meals, "university": "UZH"})
    return out


def meal_times() -> dict[int, dict[str, tuple[str, str]]]:
    """Per facility, each meal's earliest start and latest end over three weeks, from Cookpit (empty if it fails)."""
    monday = date.today() - timedelta(days=date.today().weekday())
    query = f"client-id={COOKPIT_CLIENT}&lang=en&rs-first=0&rs-size=200&valid-after={monday}&valid-before={monday + timedelta(days=20)}"
    request = urllib.request.Request(f"{COOKPIT}?{query}", headers={"User-Agent": "frooms/1.0 (+https://github.com/rafwyss/frooms)"})
    # python.org's Python on macOS has no certificates of its own until "Install Certificates" runs; use the system's.
    system = "/etc/ssl/cert.pem"
    context = ssl.create_default_context(cafile=system if os.path.exists(system) and not os.environ.get("SSL_CERT_FILE") else None)
    try:
        with urllib.request.urlopen(request, timeout=30, context=context) as resp:
            rotas = json.load(resp)["weekly-rota-array"]
    except (OSError, ValueError, KeyError) as e:
        print(f"Cookpit unavailable ({type(e).__name__}), using lunch 11:00-14:00 for every mensa", file=sys.stderr)
        return {}
    times: dict[int, dict[str, tuple[str, str]]] = {}
    for rota in rotas:
        meals = times.setdefault(rota["facility-id"], {})
        for day in rota.get("day-of-week-array") or []:
            for hours in day.get("opening-hour-array") or []:
                for m in hours.get("meal-time-array") or []:
                    if not m.get("line-array"):
                        continue
                    meal = "lunch" if m["time-from"] < DINNER_FROM else "dinner"
                    start, end = meals.get(meal, ("99:99", "00:00"))
                    meals[meal] = (min(start, m["time-from"]), max(end, m["time-to"]))
    return times


def quarters(start: str, end: str) -> list[str]:
    """Every quarter hour from `start` (rounded up) to before `end`, as HHMM. Must match the app's time picker."""
    to_min = lambda t: int(t[:2]) * 60 + int(t[3:5])
    first = -(-to_min(start) // 15) * 15
    return [f"{m // 60:02d}{m % 60:02d}" for m in range(first, to_min(end), 15)]


_fonts: dict = {}


def font(size: int, weight: int, width: float = 100) -> ImageFont.FreeTypeFont:
    key = (size, weight, width)
    if key not in _fonts:
        f = ImageFont.truetype(str(FONT), size)
        f.set_variation_by_axes([weight, width])
        _fonts[key] = f
    return _fonts[key]


def cover(path: Path) -> Image.Image:
    """The background, centre-cropped to the card's aspect ratio and resized to WIDTH x HEIGHT."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    if w / h > WIDTH / HEIGHT:
        cw = round(h * WIDTH / HEIGHT)
        img = img.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h))
    else:
        ch = round(w * HEIGHT / WIDTH)
        img = img.crop((0, (h - ch) // 2, w, (h - ch) // 2 + ch))
    return img.resize((WIDTH, HEIGHT), Image.LANCZOS)


def with_glow(img: Image.Image, colour: list[int]) -> Image.Image:
    """Soften the middle with a blurred patch of the background's own light colour, so the text stays readable."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((200, 95, WIDTH - 200, HEIGHT - 95), fill=215)
    mask = mask.filter(ImageFilter.GaussianBlur(70))
    return Image.composite(Image.new("RGB", img.size, tuple(colour)), img, mask)


def room_font(draw: ImageDraw.ImageDraw, room: str, largest: int = 168) -> ImageFont.FreeTypeFont:
    for size in range(largest, 60, -4):
        f = font(size, 800, 87.5)
        if draw.textlength(room, font=f) <= MAX_TEXT_WIDTH:
            return f
    return font(60, 800, 87.5)


def name_lines(draw: ImageDraw.ImageDraw, name: str) -> tuple[list[str], ImageFont.FreeTypeFont]:
    """A space's name on one line, or on two if that allows a clearly larger font."""
    one = room_font(draw, name, 132)
    words = name.split()
    if one.size >= 100 or len(words) < 2:
        return [name], one
    best = ([name], one)
    for i in range(1, len(words)):
        lines = [" ".join(words[:i]), " ".join(words[i:])]
        f = min((room_font(draw, line, 110) for line in lines), key=lambda f: f.size)
        if f.size > best[1].size:
            best = (lines, f)
    return best


def render(base: Image.Image, style: dict, room: str | None, space: dict | None = None) -> Image.Image:
    img = base.copy()
    draw = ImageDraw.Draw(img)
    small = font(50, 600)
    cx = WIDTH // 2
    if space:
        lines, big = name_lines(draw, space["name"])
        draw.text((cx, 200), "Join me at", font=small, fill=style["text"], anchor="ms")
        y = 350 if len(lines) == 1 else 300  # baseline of the first line
        for i, line in enumerate(lines):
            draw.text((cx, y + i * big.size), line, font=big, fill=style["room"], anchor="ms")
        last = y + (len(lines) - 1) * big.size
        draw.text((cx, last + 80), space["room"], font=font(40, 600), fill=style["text"], anchor="ms")
    elif room:
        big = room_font(draw, room)
        draw.text((cx, 245), "Join me in", font=small, fill=style["text"], anchor="ms")
        draw.text((cx, 400), room, font=big, fill=style["room"], anchor="ms")
    else:
        # The page's card (og:image) and the fallback for an invite: the page title's words, on every background.
        draw.text((cx, 290), "Friends & free rooms", font=font(72, 800, 87.5), fill=style["room"], anchor="ms")
        draw.text((cx, 370), "& more at ETH and UZH", font=font(42, 600), fill=style["text"], anchor="ms")
    # Small wordmark at the bottom: "frooms" and its red dot
    mark = font(34, 800, 87.5)
    mw = draw.textlength("frooms", font=mark)
    x = cx - (mw + 12) / 2
    draw.text((x, 560), "frooms", font=mark, fill=MARK, anchor="ls")
    draw.ellipse((x + mw + 4, 552, x + mw + 12, 560), fill=DOT)
    return img


def university(style: dict) -> str:
    """Whose places a background is for: "UZH" or "ETH" (the default)."""
    return style.get("university", "ETH")


MEAL_WORDS = {"lunch": "Lunch at", "dinner": "Dinner at"}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
# The invites without a time, by day; must match the worker's mealWhen() in worker/index.ts.
DAY_QUESTIONS = {"now": "now?", "today": "today?", "tomorrow": "tomorrow?", **{d: f"on {d.capitalize()}?" for d in WEEKDAYS}}


def render_meal(base: Image.Image, style: dict, meal: str, name: str, when: str) -> Image.Image:
    """"Lunch at" / the mensa / "at 12:15?" (or "now?", "today?", "tomorrow?", "on Friday?" without a time)."""
    img = base.copy()
    draw = ImageDraw.Draw(img)
    cx = WIDTH // 2
    lines, big = name_lines(draw, name)
    draw.text((cx, 200), MEAL_WORDS[meal], font=font(50, 600), fill=style["text"], anchor="ms")
    y = 350 if len(lines) == 1 else 300
    for i, line in enumerate(lines):
        draw.text((cx, y + i * big.size), line, font=big, fill=style["room"], anchor="ms")
    last = y + (len(lines) - 1) * big.size
    question = DAY_QUESTIONS.get(when) or f"at {when[:2]}:{when[2:]}?"
    draw.text((cx, last + 90), question, font=font(60, 700), fill=style["text"], anchor="ms")
    mark = font(34, 800, 87.5)
    mw = draw.textlength("frooms", font=mark)
    x = cx - (mw + 12) / 2
    draw.text((x, 580), "frooms", font=mark, fill=MARK, anchor="ls")
    draw.ellipse((x + mw + 4, 572, x + mw + 12, 580), fill=DOT)
    return img


def meal_cards(spaces: list[dict], force: bool, inputs_mtime: float) -> tuple[int, list[dict], int]:
    """The meal invite images, each mensa on its university's backgrounds; returns (written, backgrounds, images)."""
    styles = json.loads((BACKGROUNDS / "meals.json").read_text())
    times = meal_times()
    cards = []
    for m in mensas(spaces):
        meals = m.get("meals") or times.get(m["facility"]) or DEFAULT_MEALS
        for meal, (start, end) in sorted(meals.items()):
            for when in [*DAY_QUESTIONS, *quarters(start, end)]:
                cards.append((f"{space_slug(m['id'])}-{meal}-{when}", meal, m["name"], when, m["university"]))
    newest_inputs = max(inputs_mtime, (BACKGROUNDS / "meals.json").stat().st_mtime)
    written = total = 0
    for i, style in enumerate(styles):
        source = BACKGROUNDS / style["file"]
        newest = max(newest_inputs, source.stat().st_mtime)
        folder = OUT / "meal" / str(i)
        folder.mkdir(parents=True, exist_ok=True)
        base = None
        for slug, meal, name, when, uni in cards:
            if uni != university(style):
                continue
            total += 1
            target = folder / f"{slug}.jpg"
            if not force and target.exists() and target.stat().st_mtime > newest:
                continue
            if base is None:
                base = with_glow(cover(source), style["glow"])
            render_meal(base, style, meal, name, when).save(target, "JPEG", quality=82, optimize=True, progressive=True)
            written += 1
    return written, styles, total


def main() -> None:
    force = "--force" in sys.argv
    styles = json.loads((BACKGROUNDS / "backgrounds.json").read_text())
    rooms = catalogue()
    uzh_rooms = uzh_catalogue()
    spaces = study_spaces()
    inputs = [Path(__file__), BACKGROUNDS / "backgrounds.json", ROOT / "data" / "overrides.json", ROOT / "data" / "uzh.json"]  # our names, UZH's exclusions and mensas
    inputs_mtime = max(p.stat().st_mtime for p in inputs)
    written = total = 0
    for i, style in enumerate(styles):
        source = BACKGROUNDS / style["file"]
        newest = max(inputs_mtime, source.stat().st_mtime)
        folder = OUT / str(i)
        folder.mkdir(parents=True, exist_ok=True)
        base = None
        cards = [("_any", None, None)]
        if university(style) == "UZH":
            cards += [(share_slug(room), room, None) for room in uzh_rooms]
        else:
            cards += [(share_slug(room), room, None) for room in rooms]
            cards += [(space_slug(s["id"]), None, s) for s in spaces]
        total += len(cards)
        for slug, room, space in cards:
            target = folder / f"{slug}.jpg"
            if not force and target.exists() and target.stat().st_mtime > newest:
                continue
            if base is None:
                base = with_glow(cover(source), style["glow"])
            render(base, style, room, space).save(target, "JPEG", quality=82, optimize=True, progressive=True)
            written += 1
    meal_written, meal_styles, meal_total = meal_cards(spaces, force, inputs_mtime)
    uzh = lambda styles: [i for i, s in enumerate(styles) if university(s) == "UZH"]
    # count and meals: the number of backgrounds; uzh and uzh_meals: which of them are UZH's (the rest are ETH's).
    index = {"count": len(styles), "meals": len(meal_styles), "uzh": uzh(styles), "uzh_meals": uzh(meal_styles)}
    (OUT / "backgrounds.json").write_text(json.dumps(index) + "\n")
    print(f"{written} preview images written, {total} on {len(styles)} backgrounds in {OUT.relative_to(ROOT)}")
    print(f"{meal_written} meal invite images written, {meal_total} on {len(meal_styles)} backgrounds in {(OUT / 'meal').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
