"use client";

import { useAction, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { listenOnce, micSupported, openMic, type ListenOptions } from "@/lib/client/voice";

export type Heard = FunctionReturnType<typeof api.listening.hear>;
export type VoiceState = "idle" | "listening" | "hearing" | "error";
export type VoiceError = "denied" | "unsupported" | "silence" | "budget" | "failed";

function errorOf(error: unknown): VoiceError {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "denied";
  const code = error instanceof ConvexError ? (error.data as { code?: string }).code : undefined;
  return code === "budget" ? "budget" : "failed";
}

/**
 * One sentence at a time: record until silence, upload the WAV to Convex,
 * let Muse Voice (and, in the kitchen, Muse Spark) do the rest.
 * `keepMic` leaves the microphone open between sentences, for hands-free cooking.
 */
export function useVoice(sessionId: Id<"sessions"> | null, locale: "en" | "fr", { keepMic = false }: { keepMic?: boolean } = {}) {
  const uploadUrl = useMutation(api.voice.uploadUrl);
  const hear = useAction(api.listening.hear);
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<VoiceError | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const abort = useRef<AbortController | null>(null);

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  /** Listens for one sentence and returns what Ripe made of it, or null. */
  const capture = async (purpose: "kitchen" | "cook", options: Omit<ListenOptions, "onLevel" | "signal"> = {}): Promise<Heard | null> => {
    if (!sessionId) return null;
    if (!micSupported()) {
      setError("unsupported");
      setState("error");
      return null;
    }
    setError(null);
    try {
      stream.current ??= await openMic();
      abort.current = new AbortController();
      setState("listening");
      const clip = await listenOnce(stream.current, { ...options, onLevel: setLevel, signal: abort.current.signal });
      setLevel(0);
      if (!keepMic) release();
      if (!clip) {
        setState(keepMic ? "idle" : "error");
        if (!keepMic) setError("silence");
        return null;
      }
      setState("hearing");
      const url = await uploadUrl({ sessionId });
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: clip.wav });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const result = await hear({ sessionId, storageId, locale, purpose });
      setState("idle");
      return result;
    } catch (e) {
      if (!keepMic) release();
      setLevel(0);
      setError(errorOf(e));
      setState("error");
      return null;
    }
  };

  /** Ends the sentence now (the button pressed again) — what was said so far is kept. */
  const stop = () => abort.current?.abort();

  const reset = () => {
    setError(null);
    setState("idle");
  };

  return { state, level, error, capture, stop, release, reset };
}
