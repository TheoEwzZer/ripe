"use client";

import { useEffect, useRef, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { say } from "@/lib/client/voice";
import { cookCommand, type CookCommand } from "@/lib/voice/commands";
import { fill, type RecipeLabels } from "@/components/recipes/shared";
import { MicIcon } from "@/components/voice/VoiceButton";
import { useLiveListening } from "@/components/voice/useLiveListening";
import { useVoice } from "@/components/voice/useVoice";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COOK_KEYWORDS = ["suivant", "précédent", "répète", "minuteur", "stop", "next", "back", "repeat", "timer"];

function SpeakerIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

/**
 * Cooking without touching the phone: each step read aloud by the browser,
 * and a listening loop that sends each sentence to Muse Voice and acts on
 * "next", "repeat", "timer 5 minutes" or "stop" itself, with no model.
 */
export function CookVoice({
  sessionId,
  locale,
  live,
  stepText,
  labels: t,
  onCommand,
}: {
  sessionId: string;
  locale: "en" | "fr";
  live: boolean;
  /** The text on screen: read aloud when it changes. */
  stepText: string;
  labels: RecipeLabels;
  onCommand: (command: CookCommand) => void;
}) {
  const voice = useVoice(sessionId as Id<"sessions">, locale, { keepMic: true });
  const stream = useLiveListening(sessionId, locale, COOK_KEYWORDS);
  const [reading, setReading] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [heard, setHeard] = useState<{ text: string; understood: boolean } | null>(null);
  const handsFreeOn = useRef(false);
  const latest = useRef({ stepText, onCommand });
  useEffect(() => {
    latest.current = { stepText, onCommand };
  });

  // A new step on screen is read out when reading is on.
  useEffect(() => {
    if (reading && stepText) void say(stepText, locale);
  }, [reading, stepText, locale]);

  useEffect(
    () => () => {
      handsFreeOn.current = false;
      stream.stop();
      voice.stop();
      voice.release();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    // Unmount only: the hook's functions are stable enough for cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** One finished sentence, from the realtime stream or a recorded clip. */
  const act = async (text: string) => {
    const command = cookCommand(text);
    setHeard({ text, understood: command !== null });
    if (!command) return;
    if (command.kind === "repeat") await say(latest.current.stepText, locale);
    else latest.current.onCommand(command);
  };

  // Without the relay (local dev, or no key on the server), each sentence is recorded and sent as a clip.
  const listen = async () => {
    while (handsFreeOn.current) {
      // Never listen to our own voice reading a step.
      while (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) await sleep(150);
      const result = await voice.capture("cook", { waitMs: 8000, silenceMs: 700, maxMs: 6000 });
      if (!handsFreeOn.current) break;
      const error = voice.lastError();
      if (error === "denied" || error === "unsupported" || error === "budget") {
        handsFreeOn.current = false;
        setHandsFree(false);
        break;
      }
      if (!result?.transcript) {
        if (error) await sleep(1500);
        continue;
      }
      await act(result.transcript);
    }
  };

  const toggleHandsFree = () => {
    if (handsFreeOn.current) {
      handsFreeOn.current = false;
      setHandsFree(false);
      stream.stop();
      voice.stop();
      voice.release();
      return;
    }
    handsFreeOn.current = true;
    setHandsFree(true);
    setHeard(null);
    // Reading pairs naturally with listening: the phone talks, the cook answers.
    setReading(true);
    void stream
      .start((text) => void act(text))
      .then((streaming) => {
        if (!streaming && handsFreeOn.current) void listen();
      });
  };

  const toggle = (on: boolean) =>
    `flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${on ? "bg-kaki text-nuit" : "ring-1 ring-hairline hover:bg-glass"}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={reading}
          onClick={() => {
            if (reading && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
            setReading((r) => !r);
          }}
          className={toggle(reading)}
        >
          <SpeakerIcon />
          {t.readAloud}
        </button>
        {live && (
          <button
            type="button"
            aria-pressed={handsFree}
            onClick={toggleHandsFree}
            className={toggle(handsFree)}
            style={
              handsFree && voice.state === "listening"
                ? { boxShadow: `0 0 0 ${2 + Math.round(voice.level * 8)}px color-mix(in srgb, var(--color-kaki) 35%, transparent)` }
                : undefined
            }
          >
            <MicIcon />
            {t.handsFree}
          </button>
        )}
        {handsFree && stream.state === "live" && (
          <span className="flex items-center gap-1.5 text-xs text-ink-soft">
            <span className="size-2 animate-pulse rounded-full bg-pousse" aria-hidden="true" />
            {t.liveListening}
          </span>
        )}
      </div>
      {handsFree && (
        <p className="text-sm text-ink-soft" aria-live="polite">
          {voice.state === "hearing" ? t.handsFreeHearing : t.handsFreeHint}
          {stream.partial && <span className="block text-ink">… {stream.partial}</span>}
          {heard && (
            <span className={`block ${heard.understood ? "text-ink" : ""}`}>
              {fill(heard.understood ? t.heardCommand : t.notACommand, { text: heard.text })}
            </span>
          )}
        </p>
      )}
      {voice.error === "denied" && <p className="text-sm text-betterave">{t.micBlocked}</p>}
    </div>
  );
}
