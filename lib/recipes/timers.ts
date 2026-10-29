export type StepTimer = { seconds: number; text: string };

// "5 minutes", "10 à 12 min", "1 h", "30 sec": a range starts the timer at its low end, to check early.
const DURATION =
  /(\d+(?:[.,]\d+)?)(?:\s*(?:à|a|-|–|to|or|ou)\s*\d+(?:[.,]\d+)?)?\s*(heures?|hours?|hrs?|h|minutes?|mins?|mn|min|secondes?|seconds?|secs?)(?![\p{L}])/giu;

const UNIT_SECONDS = (unit: string) => (/^h/i.test(unit) ? 3600 : /^(m)/i.test(unit) ? 60 : 1);

/** The durations a step mentions, as timers to start with one tap; at most two per step. */
export function timersIn(step: string): StepTimer[] {
  const found: StepTimer[] = [];
  for (const match of step.matchAll(DURATION)) {
    const seconds = Math.round(Number(match[1].replace(",", ".")) * UNIT_SECONDS(match[2]));
    if (seconds < 5 || seconds > 6 * 3600 || found.some((t) => t.seconds === seconds)) continue;
    found.push({ seconds, text: match[0] });
    if (found.length === 2) break;
  }
  return found;
}

/** 90 → "1:30", 3600 → "1:00:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
