import { expect, it } from "vitest";

import { addDays, addMonths, parseQueryTime, toZurichIso, weekday, zurichDate, zurichToUtc } from "../worker/tz";

it("converts winter and summer times", () => {
  expect(zurichToUtc(2026, 10, 29, 13, 0)).toBe(Date.UTC(2026, 9, 29, 12, 0));
  expect(zurichToUtc(2026, 7, 1, 13, 0)).toBe(Date.UTC(2026, 6, 1, 11, 0));
});

it("takes the first occurrence of an ambiguous autumn time, like zoneinfo fold=0", () => {
  expect(zurichToUtc(2026, 10, 25, 2, 30)).toBe(Date.UTC(2026, 9, 25, 0, 30));
  expect(zurichToUtc(2026, 10, 25, 3, 0)).toBe(Date.UTC(2026, 9, 25, 2, 0));
});

it("maps a spring-gap time with the pre-transition offset, like zoneinfo fold=0", () => {
  expect(zurichToUtc(2026, 3, 29, 2, 30)).toBe(Date.UTC(2026, 2, 29, 1, 30));
  expect(zurichToUtc(2026, 3, 29, 3, 0)).toBe(Date.UTC(2026, 2, 29, 1, 0));
});

it("formats like Python isoformat(timespec='minutes')", () => {
  expect(toZurichIso(Date.UTC(2026, 9, 29, 12, 0))).toBe("2026-10-29T13:00+01:00");
  expect(toZurichIso(Date.UTC(2026, 9, 24, 22, 30))).toBe("2026-10-25T00:30+02:00");
});

it("parses query times", () => {
  expect(parseQueryTime("2026-10-29T14:00")).toBe(Date.UTC(2026, 9, 29, 13, 0));
  expect(parseQueryTime("2026-10-29T14:00+01:00")).toBe(Date.UTC(2026, 9, 29, 13, 0));
  expect(parseQueryTime("2026-10-29T13:00Z")).toBe(Date.UTC(2026, 9, 29, 13, 0));
  expect(parseQueryTime("tomorrow")).toBeNull();
});

it("does date arithmetic on Zurich dates", () => {
  expect(zurichDate(Date.UTC(2026, 9, 28, 23, 30))).toBe("2026-10-29");
  expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  expect(addMonths("2026-10-29", 4)).toBe("2027-02-28");
  expect(addMonths("2026-10-31", 1)).toBe("2026-11-30");
  expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  expect(weekday("2026-10-26")).toBe(0);
  expect(weekday("2026-11-01")).toBe(6);
});
