"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { say } from "@/lib/client/voice";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { useVoice, type Heard, type VoiceError } from "./useVoice";

export function MicIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

export const voiceErrorText = (error: VoiceError, t: Dictionary["voice"]) =>
  ({ denied: t.micDenied, unsupported: t.noMic, silence: t.silence, budget: t.budget, failed: t.failed })[error];

/**
 * "Talk to Ripe": one sentence adds what the photo missed, takes out what was
 * eaten, or asks for recipes. Ripe answers aloud; every screen sees the change.
 */
export function VoiceButton({
  sessionId,
  locale,
  t,
  onHeard,
}: {
  sessionId: Id<"sessions">;
  locale: "en" | "fr";
  t: Dictionary["voice"];
  onHeard?: (heard: Heard) => void;
}) {
  const voice = useVoice(sessionId, locale);
  const undo = useMutation(api.voice.undo);
  const [last, setLast] = useState<Heard | null>(null);
  const [undone, setUndone] = useState(false);

  const press = async () => {
    if (voice.state === "listening") {
      voice.stop();
      return;
    }
    setLast(null);
    setUndone(false);
    const heard = await voice.capture("kitchen");
    if (!heard) return;
    setLast(heard);
    onHeard?.(heard);
    void say(heard.reply || (heard.transcript ? t.nothingToDo : t.silence), locale);
  };

  const busy = voice.state === "hearing";
  const label = voice.state === "listening" ? t.listening : busy ? t.hearing : t.speak;
  const changed = last && (last.added.length > 0 || last.removed.length > 0);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void press()}
        disabled={busy}
        aria-pressed={voice.state === "listening"}
        className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-[box-shadow,background-color] duration-150 disabled:opacity-70 ${
          voice.state === "listening" ? "bg-kaki text-nuit" : "ring-1 ring-hairline hover:bg-glass"
        }`}
        style={
          voice.state === "listening"
            ? { boxShadow: `0 0 0 ${3 + Math.round(voice.level * 10)}px color-mix(in srgb, var(--color-kaki) 35%, transparent)` }
            : undefined
        }
      >
        <MicIcon />
        <span aria-live="polite">{label}</span>
        {busy && (
          <span className="ghost-pulse" aria-hidden="true">
            ···
          </span>
        )}
      </button>

      {(last || voice.error) && voice.state !== "listening" && !busy && (
        <div
          className="absolute right-0 z-20 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-3xl bg-surface p-4 text-sm shadow-2xl ring-1 ring-hairline"
          role="status"
        >
          {voice.error && <p className="text-betterave">{voiceErrorText(voice.error, t)}</p>}
          {last && (
            <>
              {last.transcript && <p className="text-ink-soft">{locale === "fr" ? `« ${last.transcript} »` : `“${last.transcript}”`}</p>}
              {last.reply && <p className="font-medium">{last.reply}</p>}
              {last.added.length > 0 && <p>+ {last.added.map((a) => a.name).join(", ")}</p>}
              {last.removed.length > 0 && <p className="text-ink-soft line-through">{last.removed.map((r) => r.name).join(", ")}</p>}
              {last.runStarted && <p className="font-medium">{t.recipesStarted}</p>}
            </>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            {changed && !undone ? (
              <button
                type="button"
                onClick={async () => {
                  await undo({ sessionId, added: last.added.map((a) => a.id), removed: last.removed.map((r) => r.id) });
                  setUndone(true);
                }}
                className="rounded-full px-3 py-1.5 font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
              >
                {t.undo}
              </button>
            ) : (
              <span className="text-xs text-ink-soft">{undone ? t.undone : t.hint}</span>
            )}
            <button
              type="button"
              onClick={() => {
                setLast(null);
                voice.reset();
              }}
              className="text-xs font-medium underline-offset-4 hover:underline"
            >
              {t.close}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
