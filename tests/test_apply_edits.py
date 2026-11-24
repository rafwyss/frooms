"""scripts/apply_edits.py: the edit mode's changes applied to a floor plan, and the hand-kept JSON style."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from apply_edits import apply_floor_edits, dump  # noqa: E402


def plan():
    return {"building": "HG", "area": "Z", "levels": [{
        "level": "E", "outline": "M0 0 10 0 10 10 0 10Z",
        "rooms": {"HG E 1": {"d": "M1 1 2 1 2 2Z", "at": [1.5, 1.5]}},
        "spaces": {"HGE30.7": {"d": "M3 3 4 3 4 4Z"}},
        "places": {"F2": {"space": "HGE30.7"}},
        "entrances": [{"at": [0, 5], "dir": 0, "main": True}], "links": [],
    }]}


def test_applies_shapes_lists_and_reports_what_is_gone():
    doc = plan()
    notes = apply_floor_edits(doc, {
        "E": {"shapes": {"HG E 1": "M1 1 3 1 3 3Z", "HGE30.7": "M3 3 5 3 5 5Z", "HG E 99": "M0 0 1 0 1 1Z"},
              "entrances": [{"at": [10, 5], "dir": 180.4, "main": False}], "stairs": [[2.04, 3.06]], "lifts": []},
        "Z": {"stairs": [[0, 0]]},
    })
    lv = doc["levels"][0]
    assert lv["rooms"]["HG E 1"] == {"d": "M1 1 3 1 3 3Z", "at": [1.5, 1.5]}
    assert lv["spaces"]["HGE30.7"]["d"] == "M3 3 5 3 5 5Z"
    assert lv["places"]["F2"] == {"space": "HGE30.7"}
    assert lv["entrances"] == [{"at": [10, 5], "dir": 180, "main": False}]
    assert lv["stairs"] == [[2.0, 3.1]] and lv["lifts"] == []
    assert any("HG E 99" in n for n in notes) and any(" Z:" in n for n in notes)


def test_writes_json_as_the_files_keep_it():
    data = {"_about": "x", "Z": {"buildings": {"HG": [-21.9, 177.5]}, "places": {}}}
    assert dump(data) == '{\n  "_about": "x",\n  "Z": {\n    "buildings": { "HG": [-21.9, 177.5] },\n    "places": {}\n  }\n}'
    for name in ("static/map/pins.json", "data/microwaves.json"):
        text = (ROOT / name).read_text()
        assert dump(json.loads(text)) + "\n" == text
