"use strict";

// "Near you" on the map (map.js): where a GPS position falls on a campus drawing, and the nearest open study spaces
// and free rooms. Pure functions, no DOM. The position stays on the device: nothing here sends or stores it.

// The same local projection as scripts/make_map.py (Projection): metres east (x) and south (y) of the campus
// file's `origin`.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQUATOR = 111320;

/** [x, y] in the campus drawing's metres for a GPS position. */
function gpsToMap([lat0, lon0], lat, lon) {
  return [(lon - lon0) * M_PER_DEG_LON_EQUATOR * Math.cos((lat0 * Math.PI) / 180), -(lat - lat0) * M_PER_DEG_LAT];
}

/** The GPS position [lat, lon] of a point in the campus drawing's metres (the other way round). */
function mapToGps([lat0, lon0], x, y) {
  return [lat0 - y / M_PER_DEG_LAT, lon0 + x / (M_PER_DEG_LON_EQUATOR * Math.cos((lat0 * Math.PI) / 180))];
}

/** How far (m) a point is from the drawn area: 0 inside it. */
function distanceToBounds([x0, y0, x1, y1], [x, y]) {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
}

/** "here", "40 m", "350 m", "1.2 km": straight-line distance, rounded so it doesn't look more exact than it is. */
function distanceText(m) {
  if (m < 15) return "here";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** Of a building's two suggested rooms (/api/map), the one free the longest (no end: free for the rest of the day). */
function longestFreeRoom(rooms) {
  const end = (r) => (r.free_until ? Date.parse(r.free_until) : Infinity);
  return rooms.filter(Boolean).sort((a, b) => end(b) - end(a))[0] ?? null;
}

/**
 * The buildings nearest to `here` with an open study space, and those with a room free for 2 hours or more, each
 * nearest first, at most `limit` of each. `buildings` are /api/map's summaries, `anchorOf(code)` gives a building's
 * position on the map (or null when it isn't on it), and `inside` is the building the person is in, if known
 * (distance 0).
 */
function nearby(buildings, anchorOf, here, { inside = null, limit = 3 } = {}) {
  const placed = buildings.flatMap((s) => {
    const at = anchorOf(s.building);
    if (!at) return [];
    const dist = s.building === inside ? 0 : Math.hypot(at[0] - here[0], at[1] - here[1]);
    return [{ code: s.building, dist, s }];
  }).sort((a, b) => a.dist - b.dist || (b.code === inside) - (a.code === inside)); // a tie: the building they're in
  const study = placed.filter(({ s }) => s.study?.open > 0 && s.study.best).slice(0, limit)
    .map(({ code, dist, s }) => ({ code, dist, space: s.study.best }));
  const rooms = placed.filter(({ s }) => s.rooms?.free > 0)
    .map(({ code, dist, s }) => ({ code, dist, free: s.rooms.free, room: longestFreeRoom([s.rooms.best_seminar, s.rooms.best_hall]) }))
    .filter((r) => r.room).slice(0, limit);
  return { study, rooms };
}
