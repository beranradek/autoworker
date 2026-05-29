import { describe, expect, it } from "vitest";
import { isWithinWorkHours, secondsUntilNextWorkWindow } from "../src/schedule/work-hours.js";
import { getConfig } from "../src/config.js";

const TZ = "UTC";
const at = (hour: number) => new Date(Date.UTC(2026, 4, 29, hour, 0, 0)); // 2026-05-29 is a Friday

describe("isWithinWorkHours", () => {
  it("is always open (24/7) when start === end", () => {
    for (const hour of [0, 3, 8, 13, 21, 23]) {
      expect(isWithinWorkHours(at(hour), { timeZone: TZ, startHour: 0, endHour: 0 })).toBe(true);
    }
  });

  it("treats start === end as 24/7 even for non-zero values", () => {
    expect(isWithinWorkHours(at(2), { timeZone: TZ, startHour: 9, endHour: 9 })).toBe(true);
  });

  it("respects a normal daytime window", () => {
    const opts = { timeZone: TZ, startHour: 8, endHour: 21 };
    expect(isWithinWorkHours(at(7), opts)).toBe(false);
    expect(isWithinWorkHours(at(8), opts)).toBe(true);
    expect(isWithinWorkHours(at(20), opts)).toBe(true);
    expect(isWithinWorkHours(at(21), opts)).toBe(false);
  });

  it("respects an overnight window", () => {
    const opts = { timeZone: TZ, startHour: 21, endHour: 8 };
    expect(isWithinWorkHours(at(22), opts)).toBe(true);
    expect(isWithinWorkHours(at(3), opts)).toBe(true);
    expect(isWithinWorkHours(at(12), opts)).toBe(false);
  });

  it("does not gate by weekday (open every day within the window)", () => {
    // 2026-05-30 and 05-31 are Sat/Sun; the window applies identically.
    const sat = new Date(Date.UTC(2026, 4, 30, 10, 0, 0));
    const sun = new Date(Date.UTC(2026, 4, 31, 10, 0, 0));
    const opts = { timeZone: TZ, startHour: 8, endHour: 21 };
    expect(isWithinWorkHours(sat, opts)).toBe(true);
    expect(isWithinWorkHours(sun, opts)).toBe(true);
  });
});

describe("secondsUntilNextWorkWindow", () => {
  it("returns 0 when already within the window (incl. 24/7)", () => {
    expect(secondsUntilNextWorkWindow(at(3), { timeZone: TZ, startHour: 0, endHour: 0 })).toBe(0);
    expect(secondsUntilNextWorkWindow(at(10), { timeZone: TZ, startHour: 8, endHour: 21 })).toBe(0);
  });

  it("waits until start when before the window", () => {
    expect(secondsUntilNextWorkWindow(at(6), { timeZone: TZ, startHour: 8, endHour: 21 })).toBe(2 * 3600);
  });
});

describe("config work-hours defaults", () => {
  it("defaults to 24/7 (WORK_HOURS_START === WORK_HOURS_END)", () => {
    const prev = process.env;
    process.env = { ...prev, GITHUB_TOKEN: "x", GITHUB_REPOS: "o/r", JOB_RUNNER: "local-docker", DRY_RUN: "true" };
    try {
      const cfg = getConfig();
      expect(cfg.WORK_HOURS_START).toBe(cfg.WORK_HOURS_END);
      expect(isWithinWorkHours(at(3), { timeZone: cfg.WORK_HOURS_TZ, startHour: cfg.WORK_HOURS_START, endHour: cfg.WORK_HOURS_END })).toBe(true);
    } finally {
      process.env = prev;
    }
  });
});
