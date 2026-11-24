"""Makes the Eat tab's mensa photos: every image in assets/mensa-photos/<place id>.<jpg|jpeg|png|webp> (dropped in by
hand, any size; git-ignored) becomes a 192 px square WebP in static/mensa-photos/<place id>.webp (centre-cropped), and
static/mensa-photos/index.json lists the ids that exist, so the page knows which card has a photo without a 404. A
tile whose source is gone is deleted. Place ids are /api/spaces' (MMB79, F8, UM1, ...).

Run from the project root: python3 scripts/make_mensa_photos.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "mensa-photos"
OUT = ROOT / "static" / "mensa-photos"
SIZE = 192
SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def main() -> int:
    SOURCE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    ids: list[str] = []
    for src in sorted(SOURCE.iterdir()):
        if src.suffix.lower() not in SUFFIXES or src.name.startswith("."):
            continue
        place = src.stem
        with Image.open(src) as im:
            tile = ImageOps.fit(ImageOps.exif_transpose(im).convert("RGB"), (SIZE, SIZE), Image.Resampling.LANCZOS)
            tile.save(OUT / f"{place}.webp", "WEBP", quality=82, method=6)
        ids.append(place)
    for stale in OUT.glob("*.webp"):
        if stale.stem not in ids:
            stale.unlink()
    (OUT / "index.json").write_text(json.dumps(ids) + "\n")
    print(f"{len(ids)} mensa photo(s) in static/mensa-photos/: {', '.join(ids) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
