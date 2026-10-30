"use client";

import { useRef, useState } from "react";
import { downsample, micSupported, openMic, tapMicrophone, toPcm16 } from "@/lib/client/voice";

export type LiveState = "off" | "connecting" | "live";

/** The relay: a Vercel function in production, `npm run listen-relay` locally (NEXT_PUBLIC_LISTEN_URL). */
function relayUrl(): string {
  const configured = process.env.NEXT_PUBLIC_LISTEN_URL;
  if (configured) return configured;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/listen`;
}

const READY_TIMEOUT_MS = 6000;

/**
 * Continuous listening: the microphone streams to Meta's realtime
 * transcription through the relay, which finds where each sentence ends.
 * `start` resolves false when the relay is not reachable, so callers can fall
 * back to recorded clips.
 */
export function useLiveListening(sessionId: string, locale: "en" | "fr", keywords: readonly string[]) {
  const [state, setState] = useState<LiveState>("off");
  const [partial, setPartial] = useState("");
  const live = useRef<{ stop: () => void } | null>(null);

  const start = async (onFinal: (text: string) => void): Promise<boolean> => {
    if (live.current || !micSupported() || typeof WebSocket === "undefined") return false;
    setState("connecting");
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch {
      setState("off");
      return false;
    }
    let socket: WebSocket | null = null;
    let stopped = false;
    const tap = await tapMicrophone(stream, (block) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const samples = downsample(block, tap.rate);
      // Never send our own voice reading a step: silence keeps the stream in real time.
      const speaking = typeof speechSynthesis !== "undefined" && speechSynthesis.speaking;
      socket.send(toPcm16(speaking ? new Float32Array(samples.length) : samples));
    });

    const release = () => {
      stopped = true;
      tap.close();
      stream.getTracks().forEach((t) => t.stop());
      live.current = null;
      setState("off");
      setPartial("");
    };

    // One connection lasts what Convex paid for (~280 s); the next one picks up where it stopped.
    const connect = () =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(relayUrl());
        ws.binaryType = "arraybuffer";
        let ready = false;
        const timeout = setTimeout(() => {
          if (!ready) ws.close();
        }, READY_TIMEOUT_MS);
        ws.onopen = () => ws.send(JSON.stringify({ type: "start", sessionId, locale, keywords }));
        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as { type: string; text?: string };
          if (message.type === "ready") {
            ready = true;
            clearTimeout(timeout);
            socket = ws;
            setState("live");
            resolve(true);
          } else if (message.type === "partial") setPartial(message.text ?? "");
          else if (message.type === "final") {
            setPartial("");
            if (message.text?.trim()) onFinal(message.text.trim());
          }
        };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (socket === ws) socket = null;
          if (!ready) resolve(false);
          else if (!stopped) {
            // Handed over at the time limit, or dropped: reconnect, or give up and let the caller fall back.
            void connect().then((again) => {
              if (!again && !stopped) release();
            });
          }
        };
      });

    if (!(await connect())) {
      release();
      return false;
    }
    live.current = {
      stop: () => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
        const closing = socket;
        release();
        setTimeout(() => closing?.close(), 2000);
      },
    };
    return true;
  };

  const stop = () => live.current?.stop();

  return { state, partial, start, stop, active: () => live.current !== null };
}
