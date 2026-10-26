/**
 * Builds a synthetic recording for fixtures/photos/fridge-drawers.jpg so the whole
 * app can be developed at $0 before an API key exists. Boxes were placed by hand
 * on the photo; masks are organic blobs inside each box, encoded in the real SAM
 * wire format and checked by round-tripping through @meta-sam/parser.
 *
 *   npm run fixtures:mock
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
// Internal encoder, not in the package exports; reached by path for test data only.
import { encodeSegmentationMask } from "../node_modules/@meta-sam/parser/dist/mask-codec.js";
import { replaySegment, type Recording } from "../lib/replay/recording";
import type { Perception } from "../lib/pantry/schema";

const W = 1920;
const H = 1280;

type Shape = "round" | "long" | "rect";
type Annotation = {
  name: string;
  samPrompt: string;
  category: Perception["ingredients"][number]["category"];
  quantity: string;
  daysLeft: number;
  freshnessCues: string;
  shape: Shape;
  boxes: [number, number, number, number][]; // pixel x1, y1, x2, y2 (inclusive)
};

const ANNOTATIONS: Annotation[] = [
  { name: "spinach", samPrompt: "baby spinach in a plastic box", category: "produce", quantity: "1 box, half full", daysLeft: 1, freshnessCues: "leaves starting to darken at the edges", shape: "rect", boxes: [[252, 340, 812, 560]] },
  { name: "broccoli", samPrompt: "broccoli", category: "produce", quantity: "1 head", daysLeft: 1, freshnessCues: "florets beginning to yellow", shape: "round", boxes: [[372, 664, 684, 852]] },
  { name: "cherry tomato", samPrompt: "cherry tomatoes in a punnet", category: "produce", quantity: "~250 g", daysLeft: 2, freshnessCues: "a few soft, wrinkled skins", shape: "rect", boxes: [[360, 208, 716, 384]] },
  { name: "zucchini", samPrompt: "green zucchini", category: "produce", quantity: "2", daysLeft: 2, freshnessCues: "firm, small soft spot near the stem", shape: "long", boxes: [[204, 796, 560, 1279]] },
  { name: "mozzarella", samPrompt: "mozzarella balls", category: "dairy", quantity: "2 balls", daysLeft: 2, freshnessCues: "opened pack", shape: "round", boxes: [[290, 0, 504, 150]] },
  { name: "eggplant", samPrompt: "eggplant", category: "produce", quantity: "1", daysLeft: 3, freshnessCues: "skin still glossy, stem slightly dry", shape: "long", boxes: [[48, 688, 324, 1272]] },
  { name: "tomato", samPrompt: "red tomatoes on the vine", category: "produce", quantity: "4", daysLeft: 3, freshnessCues: "deep red, ripe", shape: "round", boxes: [[548, 736, 864, 1004]] },
  { name: "milk", samPrompt: "milk carton", category: "dairy", quantity: "1 carton", daysLeft: 3, freshnessCues: "carton opened", shape: "rect", boxes: [[1116, 0, 1308, 420]] },
  { name: "kiwi", samPrompt: "kiwi fruit", category: "fruit", quantity: "1", daysLeft: 4, freshnessCues: "slightly soft", shape: "round", boxes: [[1212, 944, 1372, 1060]] },
  { name: "peach juice", samPrompt: "bottle of peach juice", category: "drink", quantity: "1 bottle, two thirds", daysLeft: 4, freshnessCues: "opened bottle", shape: "rect", boxes: [[1248, 0, 1632, 696]] },
  { name: "baby carrot", samPrompt: "bag of baby carrots", category: "produce", quantity: "1 bag", daysLeft: 6, freshnessCues: "bright, no slime", shape: "rect", boxes: [[588, 384, 1248, 716]] },
  { name: "orange juice", samPrompt: "bottle of orange juice", category: "drink", quantity: "1 bottle", daysLeft: 6, freshnessCues: "sealed", shape: "rect", boxes: [[1560, 0, 1919, 756]] },
  { name: "lime", samPrompt: "lime", category: "fruit", quantity: "3", daysLeft: 10, freshnessCues: "firm, green", shape: "round", boxes: [[1584, 1020, 1752, 1279]] },
  { name: "orange", samPrompt: "orange", category: "fruit", quantity: "2", daysLeft: 12, freshnessCues: "firm, glossy peel", shape: "round", boxes: [[1048, 1000, 1328, 1279], [1296, 996, 1656, 1279]] },
  { name: "lemon", samPrompt: "lemon", category: "fruit", quantity: "1", daysLeft: 14, freshnessCues: "firm, bright yellow", shape: "round", boxes: [[1004, 888, 1180, 1056]] },
];

function blob(width: number, height: number, shape: Shape, seed: number): Uint8Array {
  const raster = new Uint8Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / (width / 2);
      const dy = (y - cy) / (height / 2);
      const theta = Math.atan2(dy, dx);
      const wobble = 1 + 0.05 * Math.sin(3 * theta + seed) + 0.03 * Math.sin(7 * theta + seed * 2);
      const inside =
        shape === "rect"
          ? Math.pow(Math.abs(dx), 6) + Math.pow(Math.abs(dy), 6) <= Math.pow(0.97 * wobble, 6)
          : dx * dx + dy * dy <= Math.pow(0.96 * wobble, 2);
      raster[y * width + x] = inside ? 1 : 0;
    }
  }
  return raster;
}

/** One SAM 3.1 output line: `<0f>` then `id<|box;…|><|mask;…|>` records, as the API streams it. */
function samLineFor(a: Annotation, seed: number): string {
  const records = a.boxes.map(([x1, y1, x2, y2], i) => {
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    const mask = encodeSegmentationMask(blob(w, h, a.shape, seed + i), w, h);
    const c = (0.86 + ((seed * 7 + i) % 12) / 100).toFixed(2);
    return `${i}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${W};h=${H};c=${c}|><|mask;x=0;y=0;c=${c};data=${h},${w},${mask.payload}|>`;
  });
  return `<0f>${records.join(",")}\n`;
}

const toGrid = (v: number, size: number) => Math.round((v / size) * 1000);

async function main() {
  const perception: Perception = {
    scene: "fridge",
    ingredients: ANNOTATIONS.map((a) => {
      const xs = a.boxes.flatMap((b) => [b[0], b[2]]);
      const ys = a.boxes.flatMap((b) => [b[1], b[3]]);
      return {
        name: a.name,
        samPrompt: a.samPrompt,
        category: a.category,
        quantity: a.quantity,
        daysLeft: a.daysLeft,
        freshnessCues: a.freshnessCues,
        dateRead: null,
        bbox: {
          x_min: toGrid(Math.min(...xs), W),
          y_min: toGrid(Math.min(...ys), H),
          x_max: toGrid(Math.max(...xs), W),
          y_max: toGrid(Math.max(...ys), H),
        },
      };
    }),
  };

  const segments: Recording["segments"] = [];
  for (const [index, a] of ANNOTATIONS.entries()) {
    const rawText = samLineFor(a, index + 1);
    const parsed = await replaySegment(rawText);
    const masks = parsed.records.filter((r) => r.kind === "mask").length;
    if (parsed.outcome.status !== "completed" || masks !== a.boxes.length || parsed.diagnostics.length) {
      throw new Error(`Mask round-trip failed for ${a.name}: ${JSON.stringify(parsed.diagnostics)}`);
    }
    segments.push({ ingredientIndex: index, prompt: a.samPrompt, encoding: "one_bit", rawText, ms: 600 + index * 90 });
  }

  const recording: Recording = {
    id: "fridge-drawers.mock",
    source: "mock",
    createdAt: new Date().toISOString(),
    image: { src: "/fixtures/photos/fridge-drawers.jpg", width: W, height: H },
    perception: { model: "mock", rawText: JSON.stringify(perception), ms: 2400, costUsd: 0 },
    segments,
    totalCostUsd: 0,
  };

  const out = path.join(process.cwd(), "fixtures", "recordings", `${recording.id}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(recording, null, 2));
  const kb = Math.round(JSON.stringify(recording).length / 1024);
  console.log(`✓ ${ANNOTATIONS.length} ingredients, ${segments.length} SAM lines, round-trip OK → ${out} (${kb} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
