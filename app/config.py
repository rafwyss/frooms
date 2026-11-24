"""Central settings for the ETH free-rooms app."""

import os
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
STATIC_DIR = ROOT / "static"
SNAPSHOT_PATH = DATA_DIR / "rooms_snapshot.json"

TZ = ZoneInfo("Europe/Zurich")

BASE_URL = "https://ethz.ch/bin/ethz/roominfo"
# Optional contact for ETH's admins, e.g. FROOMS_CONTACT=you@example.com
CONTACT = os.environ.get("FROOMS_CONTACT", "").strip()
USER_AGENT = f"frooms/0.1 (personal project{'; ' + CONTACT if CONTACT else ''})"
HTTP_TIMEOUT_S = 10.0
MAX_CONCURRENT_REQUESTS = 4

CATALOGUE_TTL_S = 24 * 3600
ALLOCATIONS_TTL_S = 10 * 60
MIN_MAX_TTL_S = 24 * 3600

DEFAULT_AREA = "Z"  # Zürich Zentrum
PRIMARY_AREAS = ("Z", "H")  # shown as chips; the rest sit behind "More"
AREA_LABELS = {"Z": "ETH Zentrum", "H": "ETH Hönggerberg"}

# Chosen in Phase 1: lecture halls and seminar rooms. Meeting rooms (2110) are opt-in.
DEFAULT_TYPECODES = ("3430", "3420")

SHORT_GAP_MINUTES = 20
FREE_SOON_MINUTES = 30
