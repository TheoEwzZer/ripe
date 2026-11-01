"use client";

import { useFoodName } from "@/lib/i18n/foods";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { stapleLabel } from "@/lib/recipes/pantry";
import { clock, timersIn } from "@/lib/recipes/timers";
import type { CookCommand } from "@/lib/voice/commands";
import { CookVoice } from "./CookVoice";
import { fill, type RecipeLabels } from "@/components/recipes/shared";

type Timer = { id: number; step: number; total: number; endsAt: number };

const makeTimer = (id: number, step: number, total: number): Timer => ({ id, step, total, endsAt: Date.now() + total * 1000 });

/** Keeps the screen on while cooking; the lock drops when the tab hides, so it is asked for again on return. */
function useWakeLock() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const ask = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
        if (stopped) {
          void lock.release();
          return;
        }
        setHeld(true);
        lock.addEventListener("release", () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };
    void ask();
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, []);
  return held;
}

/** Three short beeps and a buzz; the audio context is made on the tap that started the timer. */
function ring(audio: AudioContext | null) {
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (!audio) return;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, audio.currentTime + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + i * 0.35 + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + i * 0.35);
    osc.stop(audio.currentTime + i * 0.35 + 0.3);
  }
}

/** One step per screen in large type, timers from the step's own words, the screen kept on. */
export function CookMode({
  sessionId,
  recipeId,
  locale,
  labels: t,
}: {
  sessionId: string;
  recipeId: string;
  locale: "en" | "fr";
  labels: RecipeLabels;
}) {
  const tr = useFoodName();
  const data = useQuery(api.recipes.get, { sessionId, recipeId });
  const caps = useQuery(api.scans.capabilities);
  const markCooked = useMutation(api.recipes.markCooked);
  const unmarkCooked = useMutation(api.recipes.unmarkCooked);
  const awake = useWakeLock();
  const [step, setStep] = useState(0);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [showIngredients, setShowIngredients] = useState(false);
  const [cooked, setCooked] = useState<number | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const nextId = useRef(1);
  // The ticking interval reads these; state drives the render.
  const timersRef = useRef<Timer[]>([]);
  const rung = useRef(new Set<number>());
  const setAllTimers = (next: Timer[]) => {
    timersRef.current = next;
    setTimers(next);
  };

  const steps = data?.recipe.steps ?? [];
  const finished = steps.length > 0 && step >= steps.length;

  // A timer that reaches zero rings once and stays on screen until stopped.
  useEffect(() => {
    if (timers.length === 0) return;
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const due = timersRef.current.filter((timer) => timer.endsAt <= at && !rung.current.has(timer.id));
      if (due.length === 0) return;
      for (const timer of due) rung.current.add(timer.id);
      ring(audio.current);
    }, 250);
    return () => clearInterval(tick);
  }, [timers.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, steps.length));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [steps.length]);

  if (data === undefined) return <div className="h-96 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  if (data === null) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-ink-soft">{t.notFound}</p>
        <Link href={`/${locale}/s/${sessionId}`} className="font-medium underline-offset-4 hover:underline">
          {t.backToSession}
        </Link>
      </div>
    );
  }

  const { recipe } = data;
  const start = (seconds: number) => {
    try {
      audio.current ??= new AudioContext();
    } catch {
      audio.current = null;
    }
    const timer = makeTimer(nextId.current++, step, seconds);
    setNow(timer.endsAt - seconds * 1000);
    setAllTimers([...timersRef.current, timer]);
  };
  const stop = (id: number) => setAllTimers(timersRef.current.filter((timer) => timer.id !== id));

  // What the voice loop asks for; "repeat" is handled by the loop itself.
  const onCommand = (command: CookCommand) => {
    if (command.kind === "next") setStep((s) => Math.min(s + 1, steps.length));
    else if (command.kind === "previous") setStep((s) => Math.max(s - 1, 0));
    else if (command.kind === "done") setStep(steps.length);
    else if (command.kind === "ingredients") setShowIngredients(true);
    else if (command.kind === "stopTimer") {
      const ringing = timersRef.current.filter((timer) => rung.current.has(timer.id));
      const target = ringing[0] ?? timersRef.current.at(-1);
      if (target) stop(target.id);
    } else if (command.kind === "timer") {
      const seconds = command.seconds || timersIn(steps[step] ?? "")[0]?.seconds;
      if (seconds) start(seconds);
    }
  };

  const plate = recipe.plate?.status === "ready" ? recipe.plate.url : null;
  const cookedText = (n: number) => (n === 0 ? t.cookedNone : n === 1 ? t.cookedOne : fill(t.cookedCount, { n }));

  return (
    <article className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/${locale}/s/${sessionId}`}
          className="rounded-full px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-glass hover:text-ink"
        >
          ← {t.exitCook}
        </Link>
        {awake && (
          <p className="flex items-center gap-2 text-xs text-ink-soft">
            <span className="size-2 rounded-full bg-pousse" aria-hidden="true" />
            {t.awake}
          </p>
        )}
      </div>

      <CookVoice
        sessionId={sessionId}
        locale={locale}
        live={caps?.live ?? false}
        stepText={finished ? t.readyTitle : (steps[step] ?? "")}
        labels={t}
        onCommand={onCommand}
      />

      <header className="flex flex-col gap-3">
        <h1 className="font-display text-2xl leading-tight font-extrabold tracking-tight text-balance">{recipe.title}</h1>
        <div className="flex gap-1" aria-hidden="true">
          {steps.map((_, i) => (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              onClick={() => setStep(i)}
              className={`h-1.5 flex-1 rounded-full transition-colors ${i < step ? "bg-ink/60" : i === step ? "bg-kaki" : "bg-hairline"}`}
            />
          ))}
        </div>
        <button
          type="button"
          aria-expanded={showIngredients}
          onClick={() => setShowIngredients((s) => !s)}
          className="self-start text-sm font-medium underline-offset-4 hover:underline"
        >
          {t.ingredientsToggle} ({recipe.uses.length + recipe.staples.length})
        </button>
        {showIngredients && (
          <ul className="flex flex-col gap-1 rounded-2xl bg-surface p-3 text-sm ring-1 ring-hairline">
            {recipe.uses.map((use, i) => (
              <li key={`${use.ingredient}-${i}`} className="flex justify-between gap-3">
                <span>{tr(data.items.find((item) => item._id === use.ingredientId)?.name ?? use.ingredient)}</span>
                <span className="text-ink-soft">{use.amount}</span>
              </li>
            ))}
            {recipe.staples.map((id) => (
              <li key={id} className="text-ink-soft">
                {stapleLabel(id, locale)}
              </li>
            ))}
          </ul>
        )}
      </header>

      {!finished ? (
        <section className="flex flex-1 flex-col gap-6" aria-live="polite">
          <p className="font-mono text-sm text-ink-soft">{fill(t.stepOf, { n: step + 1, total: steps.length })}</p>
          <p className="text-3xl leading-snug font-medium text-balance sm:text-4xl">{steps[step]}</p>
          <div className="flex flex-wrap gap-2">
            {timersIn(steps[step] ?? "").map((timer) => (
              <button
                key={timer.seconds}
                type="button"
                onClick={() => start(timer.seconds)}
                className="rounded-full bg-safran/20 px-4 py-2 font-medium ring-1 ring-safran/60 transition-colors hover:bg-safran/30"
              >
                ⏱ {fill(t.startTimer, { time: clock(timer.seconds) })}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="flex flex-1 flex-col gap-5">
          {plate && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={plate} alt={fill(t.plateAlt, { title: recipe.title })} className="aspect-square w-full rounded-3xl object-cover" />
          )}
          <h2 className="font-display text-4xl font-extrabold tracking-tight">{t.readyTitle}</h2>
          {cooked === null && !recipe.cookedAt ? (
            <>
              <p className="text-ink-soft">{t.readyLead}</p>
              <button
                type="button"
                onClick={async () => setCooked(await markCooked({ recipeId: recipe._id as Id<"recipes"> }))}
                className="self-start rounded-full bg-aubergine px-6 py-3 font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] dark:bg-porcelaine dark:text-aubergine"
              >
                {t.markCooked}
              </button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3" role="status">
              <p className="font-medium">{cooked === null ? t.cookedDone : cookedText(cooked)}</p>
              <button
                type="button"
                onClick={async () => {
                  await unmarkCooked({ recipeId: recipe._id as Id<"recipes"> });
                  setCooked(null);
                }}
                className="rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
              >
                {t.undoCooked}
              </button>
            </div>
          )}
          <Link href={`/${locale}/s/${sessionId}`} className="self-start font-medium underline-offset-4 hover:underline">
            {t.backToSession}
          </Link>
        </section>
      )}

      {timers.length > 0 && (
        <div className="sticky bottom-24 flex flex-col gap-2">
          {timers.map((timer) => {
            const left = (timer.endsAt - now) / 1000;
            const done = left <= 0;
            return (
              <div
                key={timer.id}
                role="timer"
                className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 shadow-lg ${
                  done
                    ? "animate-pulse bg-betterave text-porcelaine"
                    : "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine"
                }`}
              >
                <span className="font-mono text-2xl tabular-nums">{done ? t.timerDone : clock(left)}</span>
                <span className="text-xs opacity-80">{fill(t.stepOf, { n: timer.step + 1, total: steps.length })}</span>
                <button
                  type="button"
                  onClick={() => stop(timer.id)}
                  className="rounded-full bg-porcelaine/15 px-3 py-1.5 text-sm font-medium dark:bg-aubergine/10"
                >
                  {t.stopTimer}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!finished && (
        <nav
          className="sticky bottom-0 -mx-4 flex gap-3 bg-surface/90 px-4 pt-3 backdrop-blur-md"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            disabled={step === 0}
            className="rounded-full px-5 py-4 font-medium ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-40"
          >
            {t.previous}
          </button>
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            className="flex-1 rounded-full bg-aubergine px-5 py-4 text-lg font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] dark:bg-porcelaine dark:text-aubergine"
          >
            {step === steps.length - 1 ? t.finish : t.nextStep}
          </button>
        </nav>
      )}
    </article>
  );
}
