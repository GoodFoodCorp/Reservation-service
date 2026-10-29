/**
 * Wall-clock time in a time zone ↔ UTC instants, with the platform's Intl
 * data (DST included). Restaurants live in their own zone: "19:30" means
 * 19:30 in Paris whatever the server's zone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
}

/** The local date and time of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Offset (ms) of the zone from UTC at an instant. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of a local date and "HH:mm" in a time zone. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  // Two passes settle the offset around DST changes.
  let instant = wall - offsetAt(new Date(wall), timeZone);
  instant = wall - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
}
