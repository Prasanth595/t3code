const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "săptămână", "săptămâni"],
    [DAY, "zi", "zile"],
    [HOUR, "oră", "ore"],
    [MINUTE, "minut", "minute"],
    [1_000, "secundă", "secunde"],
    [1, "milisecundă", "milisecunde"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit, plural] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `În fiecare ${unit}`;
    parts.push(`${count} ${count === 1 ? unit : plural}`);
    remaining %= size;
  }
  return `La fiecare ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Următoarea rulare nu e disponibilă";
  if (remaining <= 0) return "Următoarea rulare e acum";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Următoarea rulare în mai puțin de un minut";
    const [unit, plural] = remaining < HOUR ? ["minut", "minute"] : ["oră", "ore"];
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return `Următoarea rulare în ${count} ${count === 1 ? unit : plural}`;
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return `Următoarea rulare mâine la ${time}`;
  if (days <= 7) {
    return `Următoarea rulare ${next.toLocaleDateString([], { weekday: "long" })} la ${time}`;
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Următoarea rulare ${date} la ${time}`;
}
