function getPartsInTimeZone(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second"))
  };
}

export function isWithinWorkHours(now: Date, opts: { timeZone: string; startHour: number; endHour: number }): boolean {
  const { hour } = getPartsInTimeZone(now, opts.timeZone);
  if (opts.startHour === opts.endHour) return true; // 24/7

  // Normal window (e.g. 8..21)
  if (opts.startHour < opts.endHour) return hour >= opts.startHour && hour < opts.endHour;

  // Overnight window (e.g. 21..8)
  return hour >= opts.startHour || hour < opts.endHour;
}

export function secondsUntilNextWorkWindow(
  now: Date,
  opts: { timeZone: string; startHour: number; endHour: number }
): number {
  if (isWithinWorkHours(now, opts)) return 0;

  const { hour, minute, second } = getPartsInTimeZone(now, opts.timeZone);
  const secondsIntoHour = minute * 60 + second;

  // If before start hour (same day), wait until start.
  if (opts.startHour < opts.endHour) {
    if (hour < opts.startHour) {
      return (opts.startHour - hour) * 3600 - secondsIntoHour;
    }
    // After end hour → wait until tomorrow's start (approx; timezone-safe enough for sleep).
    return (24 - hour + opts.startHour) * 3600 - secondsIntoHour;
  }

  // Overnight window: outside means we're in the "gap" [endHour, startHour).
  // If we're in the gap before startHour, wait until startHour.
  if (hour < opts.startHour) {
    return (opts.startHour - hour) * 3600 - secondsIntoHour;
  }
  // Otherwise we're >= startHour which would be inside; but we already checked outside, so this is the gap case.
  return (24 - hour + opts.startHour) * 3600 - secondsIntoHour;
}

