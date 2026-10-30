import { timersIn } from "../recipes/timers";

export type CookCommand =
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "repeat" }
  | { kind: "timer"; seconds: number }
  | { kind: "stopTimer" }
  | { kind: "ingredients" }
  | { kind: "done" };

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Order matters: "stop the timer" before "timer", "next step" before anything with "step".
const RULES: [RegExp, CookCommand["kind"]][] = [
  [/\b(stop|arrete|arreter|coupe|annule)\b.*\b(minuteur|timer|alarme|sonnerie)\b|\b(stop|arrete)\b$/, "stopTimer"],
  [/\b(minuteur|timer|chrono)\b/, "timer"],
  [/\b(suivant|suivante|apres|ensuite|next|continue|go on|on continue)\b/, "next"],
  [/\b(precedent|precedente|retour|reviens|back|previous|go back|avant)\b/, "previous"],
  [/\b(repete|repeter|redis|encore|repeat|say again|again|pardon|quoi)\b/, "repeat"],
  [/\b(ingredients?|ingredient)\b/, "ingredients"],
  [/\b(fini|termine|c est pret|done|finished|ready)\b/, "done"],
];

const WORD_NUMBERS: Record<string, number> = {
  un: 1,
  une: 1,
  one: 1,
  a: 1,
  an: 1,
  deux: 2,
  two: 2,
  trois: 3,
  three: 3,
  quatre: 4,
  four: 4,
  cinq: 5,
  five: 5,
  six: 6,
  sept: 7,
  seven: 7,
  huit: 8,
  eight: 8,
  neuf: 9,
  nine: 9,
  dix: 10,
  ten: 10,
  quinze: 15,
  fifteen: 15,
  vingt: 20,
  twenty: 20,
  trente: 30,
  thirty: 30,
};

/**
 * The hands-free words of cooking mode, recognised on the phone without a
 * model: "suivant", "répète", "minuteur 5 minutes", "stop".
 */
export function cookCommand(transcript: string): CookCommand | null {
  const text = fold(transcript);
  if (!text) return null;
  for (const [pattern, kind] of RULES) {
    if (!pattern.test(text)) continue;
    if (kind !== "timer") return { kind } as CookCommand;
    const digits = text.replace(/\b([a-z]+)\b/g, (word) => (word in WORD_NUMBERS ? String(WORD_NUMBERS[word]) : word));
    const timer = timersIn(digits)[0];
    // "Minuteur" alone starts the step's own timer; the caller knows which.
    return { kind: "timer", seconds: timer?.seconds ?? 0 };
  }
  return null;
}
