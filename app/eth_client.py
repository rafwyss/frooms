"""Async client for ETH's room-info API, with caching and a concurrency limit."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import date, timedelta
from urllib.parse import quote

import httpx

from .config import (
    ALLOCATIONS_TTL_S,
    BASE_URL,
    CACHE_DIR,
    CATALOGUE_TTL_S,
    HTTP_TIMEOUT_S,
    MAX_CONCURRENT_REQUESTS,
    MIN_MAX_TTL_S,
    SNAPSHOT_PATH,
    USER_AGENT,
)

log = logging.getLogger(__name__)

CATALOGUE_CACHE = CACHE_DIR / "rooms.json"


class EthClient:
    def __init__(self) -> None:
        self._http = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT_S,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
        self._cache: dict[tuple, tuple[float, object]] = {}
        self._inflight: dict[tuple, asyncio.Task] = {}

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "EthClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _get(self, path: str, **params: str) -> object:
        # Build the query by hand so spaces in room paths become %20, as ETH's own pages send them.
        query = "&".join([f"path={quote(path, safe='/')}"] + [f"{k}={quote(v)}" for k, v in params.items()])
        url = f"{BASE_URL}?{query}"
        async with self._sem:
            for attempt in range(2):
                try:
                    resp = await self._http.get(url)
                    resp.raise_for_status()
                    return resp.json()
                except (httpx.HTTPError, ValueError) as e:
                    if attempt == 1:
                        raise
                    log.warning("ETH request failed (%s), retrying: %s", e, url)
                    await asyncio.sleep(1.0)
        raise AssertionError("unreachable")

    async def _cached(self, key: tuple, ttl: float, fetch) -> object:
        """In-memory TTL cache that also collapses concurrent requests for the same key."""
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(fetch())
            self._inflight[key] = task
            task.add_done_callback(lambda _: self._inflight.pop(key, None))
        value = await task
        self._cache[key] = (time.time(), value)
        return value

    def cached_at(self, key: tuple) -> float | None:
        hit = self._cache.get(key)
        return hit[0] if hit else None

    async def catalogue(self) -> list[dict]:
        """All rooms. Disk cache for 24 h, falling back to the bundled snapshot if ETH is unreachable."""
        if CATALOGUE_CACHE.exists() and time.time() - CATALOGUE_CACHE.stat().st_mtime < CATALOGUE_TTL_S:
            return json.loads(CATALOGUE_CACHE.read_text())
        try:
            data = await self._get("/v2/rooms", lang="de")
            if not isinstance(data, list) or not data:
                raise ValueError("unexpected catalogue response")
        except (httpx.HTTPError, ValueError) as e:
            log.warning("Could not fetch catalogue (%s); using snapshot", e)
            source = CATALOGUE_CACHE if CATALOGUE_CACHE.exists() else SNAPSHOT_PATH
            return json.loads(source.read_text())
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CATALOGUE_CACHE.write_text(json.dumps(data, ensure_ascii=False))
        return data

    async def min_max_dates(self) -> tuple[date, date]:
        data = await self._cached(("minmax",), MIN_MAX_TTL_S, lambda: self._get("/min-max-allocation-date"))
        return date.fromisoformat(data["minDateLoad"]), date.fromisoformat(data["maxDateLoad"])

    async def allocations(self, room_path: str, day: date) -> list[dict]:
        """Allocations for `day` and the following day (so late-evening queries still see the next morning)."""
        start, end = day.isoformat(), (day + timedelta(days=1)).isoformat()
        return await self._cached(
            ("alloc", room_path, start),
            ALLOCATIONS_TTL_S,
            lambda: self._get(f"/rooms/{room_path}/allocations", **{"from": start, "to": end}),
        )
