/** Create a normalized dedup key from artist names + track name. */
export function trackKey(
  artists: Array<{ name: string }>,
  trackName: string,
): string {
  const artistNames = artists
    .map((a) => a.name.toLowerCase())
    .sort()
    .join("|");
  return `${artistNames}::${trackName.toLowerCase()}`;
}

/** Deduplicate track IDs, keeping first occurrence. */
export function dedup(trackIds: string[]): string[] {
  return [...new Set(trackIds)];
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format milliseconds to human-readable hours/minutes (e.g. "2h 45m"). */
export function formatHm(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// ── Date helpers ────────────────────────────────────────────────────────────

/** Parse date string DD.MM.YY to Date object. */
export function parseDate(dateStr: string): Date {
  const [day, month, year] = dateStr.split(".");
  const fullYear =
    Number.parseInt(year) < 50
      ? 2000 + Number.parseInt(year)
      : 1900 + Number.parseInt(year);
  return new Date(fullYear, Number.parseInt(month) - 1, Number.parseInt(day));
}

/** Format Date to YYYY-MM-DD. */
export function formatDateISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Format Date to DD.MM.YY. */
export function formatDdMmYy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

/** Find the Friday that ends the release week (Sat–Fri) containing a date. */
export function toReleaseFriday(d: Date): Date {
  const day = d.getDay(); // 0=Sun … 6=Sat
  const offset = (5 - day + 7) % 7;
  const fri = new Date(d);
  fri.setDate(fri.getDate() + offset);
  return fri;
}

/** Get valid release dates for a Friday playlist (full week: Sat-Fri). */
export function getValidDates(fridayDate: Date): string[] {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(fridayDate);
    d.setDate(d.getDate() - i);
    dates.push(formatDateISO(d));
  }
  return dates;
}

/** Generate all Friday date strings (DD.MM.YY) from start to end. */
export function generateFridayDates(
  startDate: Date,
  endDate: Date,
): string[] {
  const fridays: string[] = [];
  const current = new Date(startDate);

  while (current.getDay() !== 5) {
    current.setDate(current.getDate() + 1);
  }

  while (current <= endDate) {
    fridays.push(formatDdMmYy(current));
    current.setDate(current.getDate() + 7);
  }

  return fridays;
}
