/**
 * One real SAM 3.1 video call: uploads a clip and tracks boxes drawn on its
 * first frame, then prints how each object moved. Costs $0.20 per 1,000 frames.
 *
 *   npm run probe:track -- --video clip.mp4 --boxes "100,80,300,260;400,90,560,250"
 */
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { trackVideo, uploadVideo } from "../lib/meta/track";

loadEnv({ path: ".env.local", override: false });

const { values } = parseArgs({
  options: { video: { type: "string" }, boxes: { type: "string" }, width: { type: "string" }, height: { type: "string" } },
});

async function main() {
  if (!values.video || !values.boxes || !values.width || !values.height)
    throw new Error("--video, --boxes, --width and --height are required");
  const objects = values.boxes.split(";").map((b, i) => {
    const [x1, y1, x2, y2] = b.split(",").map(Number);
    return { id: i + 1, box: { x1, y1, x2, y2 } };
  });
  const started = Date.now();
  const fileId = await uploadVideo(new Blob([await readFile(values.video)], { type: "video/mp4" }), path.basename(values.video));
  console.log(`uploaded ${fileId} in ${Date.now() - started} ms`);
  const result = await trackVideo({ fileId }, objects, { w: Number(values.width), h: Number(values.height) });
  console.log(`tracked in ${result.ms} ms, ${result.frames} frames, $${result.costUsd.toFixed(4)}, size ${JSON.stringify(result.size)}`);
  for (const [id, list] of result.tracks) {
    const first = list[0];
    const last = list.at(-1)!;
    console.log(
      `  object ${id}: ${list.length} frames, frame ${first[0]} [${first.slice(1).join(",")}] → frame ${last[0]} [${last.slice(1).join(",")}]`,
    );
  }
  if (result.tracks.size === 0) console.log(result.rawText.slice(0, 500));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
