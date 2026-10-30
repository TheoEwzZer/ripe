/**
 * The listening relay outside Vercel, for local development: `next dev`
 * cannot upgrade WebSockets, so this serves lib/voice/relay.ts on its own port.
 *
 *   npm run listen-relay            # ws://localhost:8790
 *   NEXT_PUBLIC_LISTEN_URL=ws://localhost:8790 npm run dev:frontend
 */
import { config as loadEnv } from "dotenv";
import { WebSocketServer } from "ws";
import { relay } from "../lib/voice/relay";

loadEnv({ path: ".env.local" });
const port = Number(process.env.LISTEN_RELAY_PORT ?? 8790);
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");

new WebSocketServer({ port }).on("connection", (ws) => relay(ws, { convexUrl, apiKey: process.env.MODEL_API_KEY }));
console.log(`listening relay on ws://localhost:${port}`);
