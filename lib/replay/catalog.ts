import drawersLive from "../../fixtures/recordings/fridge-drawers.live.json";
import drawersMock from "../../fixtures/recordings/fridge-drawers.mock.json";
import fullLive from "../../fixtures/recordings/fridge-full.live.json";
import type { Recording } from "./recording";

/**
 * Recordings bundled with the backend for demo scans, replayed at $0. The
 * live one is a real Meta Model API pass made with `npm run probe`.
 */
export const recordings: Record<string, Recording> = {
  [drawersLive.id]: drawersLive as unknown as Recording,
  [drawersMock.id]: drawersMock as unknown as Recording,
  [fullLive.id]: fullLive as unknown as Recording,
};

/** Demo photos in the order "add a photo" offers them; the first one starts every demo. */
export const demoRecordingIds: string[] = [drawersLive.id, fullLive.id];
export const defaultRecordingId = demoRecordingIds[0];
