/**
 * Records one spoken sentence from the microphone: it starts on the first
 * sound, stops after a short silence, and comes back as the WAV Muse Voice
 * expects (mono, 16-bit PCM, 16 kHz). Nothing listens between sentences.
 */

export const VOICE_RATE = 16_000;

export type Clip = { wav: Blob; ms: number };

export type ListenOptions = {
  /** Silence that ends the sentence once speech has started. */
  silenceMs?: number;
  /** Give up if nobody speaks for this long. */
  waitMs?: number;
  /** Hard cap on one sentence. */
  maxMs?: number;
  /** 0–1 input level, for the meter. */
  onLevel?: (level: number) => void;
  /** Fires once, when speech is first heard. */
  onSpeech?: () => void;
  signal?: AbortSignal;
};

// Collects microphone samples in blocks; runs on the audio thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.at = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.buffer[this.at++] = input[i];
        if (this.at === this.buffer.length) { this.port.postMessage(this.buffer.slice(0)); this.at = 0; }
      }
    }
    return true;
  }
}
registerProcessor("ripe-tap", Tap);
`;

let workletUrl: string | null = null;

/** Averages blocks of samples down to 16 kHz. */
export function downsample(samples: Float32Array, from: number, to = VOICE_RATE): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** RIFF/WAVE, mono, 16-bit little-endian PCM. */
export function encodeWav(samples: Float32Array, rate = VOICE_RATE): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function micSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== "undefined";
}

/** Opens the microphone once; keep the stream for the next sentences so the browser asks only once. */
export async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/**
 * Listens for one sentence. Resolves with the clip, or null if nobody spoke
 * (or the signal aborted before any speech).
 */
export async function listenOnce(stream: MediaStream, options: ListenOptions = {}): Promise<Clip | null> {
  const { silenceMs = 900, waitMs = 7000, maxMs = 12_000, onLevel, onSpeech, signal } = options;
  const context = new AudioContext();
  workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(context, "ripe-tap");
  source.connect(tap);
  // A node the destination does not pull is never run; the tap writes silence, so nothing is heard.
  tap.connect(context.destination);

  const rate = context.sampleRate;
  const blocks: Float32Array[] = [];
  let total = 0;
  let floor = 0.004;
  let speechAt = -1;
  let lastLoud = 0;

  return new Promise<Clip | null>((resolve) => {
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      tap.port.onmessage = null;
      source.disconnect();
      tap.disconnect();
      void context.close();
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(guard);
      if (!keep || speechAt < 0) {
        resolve(null);
        return;
      }
      // Keep a little air before the first word, drop the trailing silence but a beat.
      const from = Math.max(0, speechAt - Math.round(rate * 0.3));
      const to = Math.min(total, lastLoud + Math.round(rate * 0.35));
      const all = new Float32Array(total);
      let at = 0;
      for (const block of blocks) {
        all.set(block, at);
        at += block.length;
      }
      const clip = downsample(all.subarray(from, to), rate);
      resolve({ wav: encodeWav(clip), ms: Math.round((clip.length / VOICE_RATE) * 1000) });
    };
    const onAbort = () => finish(speechAt >= 0);
    signal?.addEventListener("abort", onAbort);
    // If the microphone sends nothing at all, stop anyway.
    const guard = setTimeout(() => finish(true), waitMs + maxMs);

    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const block = event.data;
      blocks.push(block);
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      const rms = Math.sqrt(sum / block.length);
      const threshold = Math.max(0.012, floor * 3);
      const loud = rms > threshold;
      // The noise floor follows the room while nobody speaks.
      if (!loud) floor = floor * 0.95 + rms * 0.05;
      total += block.length;
      onLevel?.(Math.min(1, rms / 0.12));
      if (loud) {
        lastLoud = total;
        if (speechAt < 0) {
          speechAt = total - block.length;
          onSpeech?.();
        }
      }
      const now = (total / rate) * 1000;
      if (speechAt < 0 && now > waitMs) finish(false);
      else if (speechAt >= 0 && ((total - lastLoud) / rate) * 1000 > silenceMs) finish(true);
      else if (now > maxMs) finish(true);
    };
  });
}

/** Reads a sentence aloud with the browser's own voice (Meta has no speech synthesis). */
export function say(text: string, locale: "en" | "fr"): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined" || !text) return resolve();
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale === "fr" ? "fr-FR" : "en-US";
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(locale));
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.speak(utterance);
  });
}
