import { ConvexHttpClient } from "convex/browser";
import type { WebSocket as ClientSocket } from "ws";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MODELS } from "../meta/models";

/**
 * The realtime listening relay. Meta's realtime endpoint takes the API key in
 * its first frame, so a browser cannot connect to it directly; this relay
 * holds the key, opens the upstream stream once Convex has paid for it, then
 * passes the phone's PCM up and the transcripts down.
 *
 * Browser → relay: {"type":"start",sessionId,locale,keywords}, then binary
 * 16 kHz 16-bit mono PCM, then {"type":"stop"}.
 * Relay → browser: ready, partial {text}, final {text}, closing, error {code}.
 */

const REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";
/** Audio that arrives before Meta acknowledges the handshake waits here, up to ~5 s. */
const MAX_PENDING_BYTES = 16_000 * 2 * 5;
/** 16 kHz, 16-bit mono: what one second of paid audio weighs. */
const BYTES_PER_SECOND = 16_000 * 2;

type Start = { type: "start"; sessionId: string; locale: "en" | "fr"; keywords?: string[] };

function send(client: ClientSocket, message: object) {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

function parseStart(raw: string): Start | null {
  try {
    const data = JSON.parse(raw) as Partial<Start>;
    if (data.type !== "start" || typeof data.sessionId !== "string" || (data.locale !== "en" && data.locale !== "fr")) return null;
    const keywords = Array.isArray(data.keywords) ? data.keywords.filter((k): k is string => typeof k === "string").slice(0, 50) : [];
    return { type: "start", sessionId: data.sessionId, locale: data.locale, keywords };
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string {
  const data = (error as { data?: { code?: string } })?.data;
  return data?.code ?? "failed";
}

/** Serves one browser connection until either side closes or the paid time runs out. */
export function relay(client: ClientSocket, opts: { convexUrl: string; apiKey: string | undefined; realtimeUrl?: string }) {
  let upstream: WebSocket | null = null;
  let ready = false;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  /** Audio is paid by the second up front: never forward more than that, however fast it arrives. */
  let paidBytes = 0;
  let sentBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const shutdown = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      // Half-close so Meta flushes the last words, then let it close the socket.
      upstream.send(JSON.stringify({ type: "endStream" }));
      setTimeout(() => upstream?.close(), 1500);
    }
    if (client.readyState === client.OPEN) client.close(code, reason);
  };

  const begin = async (start: Start) => {
    if (!opts.apiKey) {
      send(client, { type: "error", code: "live_disabled" });
      return shutdown(1008, "live disabled");
    }
    let seconds: number;
    try {
      ({ seconds } = await new ConvexHttpClient(opts.convexUrl).mutation(api.voice.openStream, {
        sessionId: start.sessionId as Id<"sessions">,
      }));
    } catch (error) {
      send(client, { type: "error", code: errorCode(error) });
      return shutdown(1008, "refused");
    }
    if (closed) return;
    paidBytes = seconds * BYTES_PER_SECOND;

    upstream = new WebSocket(opts.realtimeUrl ?? REALTIME_URL);
    upstream.binaryType = "arraybuffer";
    upstream.addEventListener("open", () => {
      upstream?.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${opts.apiKey}` },
          audioEncoding: "PCM_16KHZ",
          model: MODELS.transcribe,
          // Meta finds the end of each sentence itself: no voice detection on the phone.
          mode: "ENDPOINTING",
          emitAudioProgress: false,
          ...(start.keywords?.length ? { keywords: start.keywords } : {}),
          languageBias: start.locale === "fr" ? ["French", "English"] : ["English"],
        }),
      );
    });
    upstream.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: { type?: string; sessionId?: string; transcript?: string; turnId?: number; message?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.type) {
        // The handshake acknowledgement: audio can flow.
        ready = true;
        for (const chunk of pending) upstream?.send(chunk);
        sentBytes += pendingBytes;
        pending = [];
        pendingBytes = 0;
        send(client, { type: "ready", seconds });
        timer = setTimeout(() => {
          send(client, { type: "closing" });
          shutdown(4000, "time");
        }, seconds * 1000);
      } else if (message.type === "transcript") {
        send(client, { type: "partial", text: message.transcript ?? "" });
      } else if (message.type === "speechComplete") {
        send(client, { type: "final", text: message.transcript ?? "", turnId: message.turnId ?? 0 });
      } else if (message.type === "error") {
        console.error("realtime transcription error", message.message);
        send(client, { type: "error", code: "upstream" });
        shutdown(1011, "upstream error");
      }
    });
    upstream.addEventListener("close", () => shutdown(1000, "upstream closed"));
    upstream.addEventListener("error", () => {
      send(client, { type: "error", code: "upstream" });
      shutdown(1011, "upstream failed");
    });
  };

  let started = false;
  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (!started) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (ready && upstream?.readyState === WebSocket.OPEN) {
        sentBytes += chunk.length;
        if (sentBytes > paidBytes) {
          send(client, { type: "closing" });
          return shutdown(4000, "time");
        }
        upstream.send(chunk);
      } else if (pendingBytes + chunk.length <= MAX_PENDING_BYTES) {
        pending.push(chunk);
        pendingBytes += chunk.length;
      }
      return;
    }
    const text = data.toString();
    if (!started) {
      const start = parseStart(text);
      if (!start) {
        send(client, { type: "error", code: "invalid" });
        return shutdown(1008, "bad start");
      }
      started = true;
      void begin(start);
    } else if (text.includes('"stop"')) {
      shutdown(1000, "stopped");
    }
  });
  client.on("close", () => shutdown(1000, "client closed"));
  client.on("error", () => shutdown(1011, "client failed"));
}
