import { experimental_upgradeWebSocket } from "@vercel/functions";
import { connection } from "next/server";
import { relay } from "@/lib/voice/relay";

/** Vercel Hobby functions run 300 s at most; the relay hands over at 280 s and the phone reconnects. */
export const maxDuration = 300;

/** Hands-free listening: the WebSocket relay to Meta's realtime transcription (lib/voice/relay.ts). */
export async function GET() {
  await connection();
  try {
    return await experimental_upgradeWebSocket((ws) => {
      relay(ws, { convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!, apiKey: process.env.MODEL_API_KEY });
    });
  } catch {
    // `next dev` and runtimes without WebSocket upgrades: the phone falls back to recorded clips.
    return new Response("Realtime listening is not available here", { status: 501 });
  }
}
