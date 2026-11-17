/** Local calendar date shared by prompts and persistent memories. */
export function formatLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whole local calendar days from a `YYYY-MM-DD` stamp (as written by
 * `formatLocalDate`) to `now`. Both sides are local midnights, so the result
 * does not shift by a day for users away from UTC; `Math.round` absorbs the
 * 23- and 25-hour days around a DST change.
 */
export function daysSinceLocalDate(stamp: string, now = new Date()): number {
  const [year, month, day] = stamp.split("-").map(Number);
  const then = new Date(year!, month! - 1, day!).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - then) / 86400000);
}
