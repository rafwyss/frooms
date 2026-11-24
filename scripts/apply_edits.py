#!/usr/bin/env python3
"""Write the edit mode's changes (the map's /?edit, static/edit.js: its "Copy edits") into the repo.

    python3 scripts/apply_edits.py edits.json        (or: pbpaste | python3 scripts/apply_edits.py -)

The JSON is {"frooms_edits": 1, "floors": {...}, "microwaves": [...], "pins": {...}}:

- floors: {building: {level: {"shapes": {key: path}, "entrances": [{at, dir, main}], "stairs": [[x, y]],
  "lifts": [[x, y]]}}}. Merged into data/floors/edits/<building>.json (a shape replaces the one kept before; a list
  replaces the level's list), which scripts/make_floors.py applies on top of every new trace, and applied to
  static/map/floors/<building>.json right away (apply_floor_edits).
- microwaves: new entries, appended to data/microwaves.json with an id of the usual form (MW-<building>-<n>). A pin
  the browser kept for a new one is its spot.
- pins: this browser's moved labels and microwaves, merged into static/map/pins.json (null takes a pin away).

Nothing else is touched. Check the result in the floor view (npx wrangler dev) and commit it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDITS_DIR = ROOT / "data" / "floors" / "edits"
FLOORS_DIR = ROOT / "static" / "map" / "floors"


def _flat(v) -> bool:
    """A value written on one line: scalars, lists of scalars, and dicts of those."""
    if isinstance(v, dict):
        return all(_flat(x) and not isinstance(x, dict) for x in v.values())
    if isinstance(v, list):
        return all(not isinstance(x, (dict, list)) for x in v)
    return True


def dump(v, indent: int = 0) -> str:
    """JSON as these files are kept by hand: nested objects indented by two, the innermost ones on one line
    ({ "HG": [-21.9, 177.5] }, one microwave per line)."""
    pad = "  " * indent
    if isinstance(v, dict) and v and not (_flat(v) and indent > 0):
        items = [f'{pad}  {json.dumps(k, ensure_ascii=False)}: {dump(x, indent + 1)}' for k, x in v.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(v, list) and v and any(isinstance(x, (dict, list)) for x in v):
        items = [f"{pad}  {dump(x, indent + 1)}" for x in v]
        return "[\n" + ",\n".join(items) + f"\n{pad}]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(x, ensure_ascii=False, separators=(', ', ': '))}" for k, x in v.items()) + " }" if v else "{}"
    return json.dumps(v, ensure_ascii=False, separators=(", ", ": "))


def apply_floor_edits(doc: dict, edits: dict) -> list[str]:
    """Put the kept edits ({level: {...}}) into a floor plan's output (static/map/floors/<b>.json's dict). Returns
    notes on what couldn't be applied (a level or shape the plan doesn't have any more)."""
    notes = []
    levels = {lv["level"]: lv for lv in doc["levels"]}
    for level, e in edits.items():
        lv = levels.get(level)
        if lv is None:
            notes.append(f"{doc['building']} {level}: no such level in the plan, its edits are kept but not shown")
            continue
        for key, d in e.get("shapes", {}).items():
            for group in ("rooms", "spaces", "places"):
                shape = lv.get(group, {}).get(key)
                if shape and "d" in shape:
                    shape["d"] = d
                    break
            else:
                notes.append(f"{doc['building']} {level}: no shape {key!r} any more")
        if "entrances" in e:
            lv["entrances"] = [{"at": list(x["at"]), "dir": int(x["dir"]), "main": bool(x["main"])} for x in e["entrances"]]
        for field in ("stairs", "lifts"):
            if field in e:
                lv[field] = [[round(p[0], 1), round(p[1], 1)] for p in e[field]]
    return notes


def kept_edits(building: str) -> dict:
    path = EDITS_DIR / f"{building}.json"
    return json.loads(path.read_text()) if path.exists() else {}


def merge_floors(floors: dict) -> None:
    EDITS_DIR.mkdir(parents=True, exist_ok=True)
    for building, levels in floors.items():
        kept = kept_edits(building)
        for level, e in levels.items():
            k = kept.setdefault(level, {})
            if e.get("shapes"):
                k.setdefault("shapes", {}).update(e["shapes"])
            for field in ("entrances", "stairs", "lifts"):
                if field in e:
                    k[field] = e[field]
        (EDITS_DIR / f"{building}.json").write_text(json.dumps(kept, ensure_ascii=False, indent=1) + "\n")
        out = FLOORS_DIR / f"{building}.json"
        if not out.exists():
            print(f"  {building}: no floor plan in static/map/floors/, edits kept for make_floors.py")
            continue
        doc = json.loads(out.read_text())
        for note in apply_floor_edits(doc, kept):
            print("  !", note)
        out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
        n = sum(len(e.get("shapes", {})) + sum(f in e for f in ("entrances", "stairs", "lifts")) for e in levels.values())
        print(f"  {building}: {n} change(s) -> data/floors/edits/{building}.json and {out.relative_to(ROOT)}")


def add_microwaves(new: list, pins: dict) -> None:
    if not new:
        return
    path = ROOT / "data" / "microwaves.json"
    data = json.loads(path.read_text())
    have = data["microwaves"]
    for m in new:
        n = 1 + sum(1 for x in have if x["building"] == m["building"])
        mid = f"MW-{m['building']}-{n}"
        while any(x["id"] == mid for x in have):
            n += 1
            mid = f"MW-{m['building']}-{n}"
        at = pins.get(m["area"], {}).get("microwaves", {}).pop(m["id"], None) or m["at"]
        have.append({"id": mid, "area": m["area"], "building": m["building"], "name": m["name"], "count": int(m["count"]),
                     "place": m.get("place"), "floor": m.get("floor"), "at": [round(at[0], 1), round(at[1], 1)]})
        print(f"  microwave {mid}: {m['count']} × {m['name']} in {m['building']}{', floor ' + m['floor'] if m.get('floor') else ''}")
    path.write_text(dump(data) + "\n")


def merge_pins(pins: dict) -> None:
    path = ROOT / "static" / "map" / "pins.json"
    data = json.loads(path.read_text())
    n = 0
    for area, kinds in pins.items():
        for kind, ids in (kinds or {}).items():
            for pid, at in (ids or {}).items():
                target = data.setdefault(area, {}).setdefault(kind, {})
                if at is None:
                    target.pop(pid, None)
                else:
                    target[pid] = [round(at[0], 1), round(at[1], 1)]
                n += 1
    if n:
        path.write_text(dump(data) + "\n")
        print(f"  {n} pin(s) -> static/map/pins.json")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    text = sys.stdin.read() if sys.argv[1] == "-" else Path(sys.argv[1]).read_text()
    edits = json.loads(text)
    if edits.get("frooms_edits") != 1:
        sys.exit("Not the edit mode's JSON (no frooms_edits: 1)")
    pins = edits.get("pins", {}) or {}
    add_microwaves(edits.get("microwaves", []), pins)  # takes the new microwaves' pins out of `pins`
    merge_floors(edits.get("floors", {}))
    merge_pins(pins)
    return 0


if __name__ == "__main__":
    sys.exit(main())
