/**
 * A local stand-in for the Meta Model API, answering from a recording. It
 * checks request shapes the way the docs describe them and streams SAM output
 * as Responses API server-sent events, so the live code path (OpenAI SDK,
 * streaming, parser, pipeline) runs end to end at $0.
 *
 *   npm run fake-meta                          # http://localhost:8787/v1
 *   META_BASE_URL=http://localhost:8787/v1 MODEL_API_KEY=fake npm run probe -- --out /tmp/rec.json
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Recording } from "../lib/replay/recording";

const PORT = Number(process.env.FAKE_META_PORT ?? 8787);
const recording = JSON.parse(readFileSync("fixtures/recordings/fridge-drawers.mock.json", "utf8")) as Recording;
const MODELS = ["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-image-1.0", "sam-3.1"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function reject(res: ServerResponse, message: string) {
  console.log(`  ✗ 400 ${message}`);
  send(res, 400, { error: { message, type: "invalid_request_error" } });
}

async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isImageUrl = (url: unknown) => typeof url === "string" && /^(https?:\/\/|data:image\/(jpeg|png|webp|gif);base64,)/.test(url);

/** Three plausible recipes from the kitchen in the prompt; the first needs spaghetti, so the correction round runs. */
function fakeRecipes(messages: { role: string; content: string }[]) {
  const prompt = messages[0]?.content ?? "";
  const names = [...prompt.matchAll(/^- (.+?)(?: \((.*)\))?: eat within (\d+) day/gm)].map((m) => m[1]);
  const recipe = (title: string, uses: string[], extra: string[] = []) => ({
    title,
    pitch: `Uses up the ${uses.slice(0, 2).join(" and ")} before they turn.`,
    minutes: 20,
    servings: 2,
    equipment: ["hob"],
    dishes: 1,
    diet: ["vegetarian"],
    uses: [...uses, ...extra].map((ingredient) => ({ ingredient, amount: "1", share: 0.8 })),
    staples: ["oil", "salt-pepper"],
    toBuy: [],
    steps: ["Wash and chop everything.", "Cook it in the pan for 10 minutes.", "Season and serve."],
  });
  if (prompt.includes("Rewrite it without")) return [recipe("Swapped skillet", names.slice(0, 3))];
  const fix = /Rewrite exactly these (\d+)/.exec(messages.at(-1)?.content ?? "");
  if (messages.length >= 3 && fix) return Array.from({ length: Number(fix[1]) }, (_, i) => recipe(`Fixed skillet ${i + 1}`, names.slice(0, 2)));
  return [
    recipe("Green pasta skillet", names.slice(0, 2), ["spaghetti"]),
    recipe("Roasted tray", names.slice(2, 5)),
    recipe("Quick soup", [names[1], names[5]].filter(Boolean)),
  ];
}

async function chatCompletion(req: Json, res: ServerResponse) {
  if (req.model !== "muse-spark-1.3" && req.model !== "muse-spark-1.3-contributor" && req.model !== "muse-wonder-1.0") {
    return send(res, 404, { error: { code: "model_not_found", message: `Unknown model ${String(req.model)}` } });
  }
  if (req.reasoning_effort !== undefined && !EFFORTS.includes(String(req.reasoning_effort))) return reject(res, "bad reasoning_effort");
  const format = req.response_format as { type?: string; json_schema?: { name?: string; schema?: unknown } } | undefined;
  if (format?.type !== "json_schema" || !format.json_schema?.schema) return reject(res, "expected a json_schema response_format");

  let content: string;
  if (format.json_schema.name === "perception") {
    const parts = (req.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]?.content ?? [];
    const image = parts.find((p) => p.type === "image_url");
    if (!isImageUrl(image?.image_url?.url)) return reject(res, "perception needs an image_url part with a URL or data URL");
    content = recording.perception.rawText;
  } else if (format.json_schema.name === "recipes") {
    content = JSON.stringify({ recipes: fakeRecipes(req.messages as { role: string; content: string }[]) });
  } else {
    return reject(res, `unknown schema ${String(format.json_schema.name)}`);
  }
  const usage = { prompt_tokens: 2400, completion_tokens: 900, total_tokens: 3300 };
  if (req.stream === true) {
    // Chat Completions streaming: content deltas, then a usage-only chunk, then [DONE].
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const event = (payload: Json) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: req.model };
    event({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (let i = 0; i < content.length; i += 90) {
      event({ ...base, choices: [{ index: 0, delta: { content: content.slice(i, i + 90) }, finish_reason: null }] });
      await sleep(20);
    }
    const options = (req.stream_options ?? {}) as Json;
    if (options.include_usage === true) event({ ...base, choices: [], usage });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  send(res, 200, {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage,
  });
}

async function responses(req: Json, res: ServerResponse) {
  if (req.model !== "sam-3.1") return send(res, 404, { error: { code: "model_not_found", message: String(req.model) } });
  const metadata = (req.metadata ?? {}) as Json;
  if (metadata.include_confidence !== undefined && metadata.include_confidence !== "true" && metadata.include_confidence !== "false") {
    return reject(res, "metadata values must be strings");
  }
  if (metadata.mask_encoding !== undefined && !["lossless", "one_bit"].includes(String(metadata.mask_encoding))) {
    return reject(res, "bad mask_encoding");
  }
  const content = (req.input as { content: { type: string; text?: string; image_url?: string }[] }[])[0]?.content ?? [];
  const texts = content.filter((c) => c.type === "input_text");
  const image = content.find((c) => c.type === "input_image");
  if (texts.length !== 1) return reject(res, "SAM takes exactly one input_text");
  if (!isImageUrl(image?.image_url)) return reject(res, "SAM needs an input_image with a URL or data URL");

  const prompt = texts[0].text ?? "";
  if (!prompt.startsWith("<") && /[,;+]/.test(prompt)) return reject(res, "concept prompts are one noun phrase, not a list");
  const rawText = prompt.startsWith("<0f>")
    ? prompt === recording.boxFallback?.prompt
      ? recording.boxFallback.rawText
      : ""
    : (recording.segments.find((s) => s.prompt === prompt)?.rawText ?? "");
  console.log(`  ↳ ${prompt.startsWith("<0f>") ? "box prompt" : `"${prompt}"`}: ${rawText.length} chars`);

  if (req.stream !== true) {
    return send(res, 200, { id: "resp_fake", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: rawText }] }] });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let sequence = 0;
  const emit = (event: Json) => res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  const lane = { item_id: "msg_fake", output_index: 0, content_index: 0 };

  emit({ type: "response.created", response: { id: "resp_fake", status: "in_progress" } });
  for (let i = 0; i < rawText.length; i += 300) {
    emit({ type: "response.output_text.delta", ...lane, delta: rawText.slice(i, i + 300) });
    await sleep(5);
  }
  emit({ type: "response.output_text.done", ...lane, text: rawText });
  emit({ type: "response.completed", response: { id: "resp_fake", status: "completed" } });
  res.end();
}

createServer(async (req, res) => {
  const url = req.url ?? "";
  console.log(`${req.method} ${url}`);
  if (req.headers.authorization?.startsWith("Bearer ") !== true) {
    return send(res, 401, { error: { message: "Missing bearer token" } });
  }
  try {
    if (req.method === "GET" && url === "/v1/models") {
      return send(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "meta" })) });
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      await sleep(300);
      return await chatCompletion(await body(req), res);
    }
    if (req.method === "POST" && url === "/v1/images/edits") {
      const request = await body(req);
      const images = request.images as { image_url?: string }[] | undefined;
      if (request.model !== "muse-image-1.0" || !isImageUrl(images?.[0]?.image_url)) return reject(res, "images/edits needs muse-image-1.0 and an image URL");
      await sleep(1500);
      return send(res, 200, { data: [{ b64_json: readFileSync("public/fixtures/plates/fridge-drawers.live.webp").toString("base64") }] });
    }
    if (req.method === "POST" && url === "/v1/responses") {
      await sleep(150);
      return await responses(await body(req), res);
    }
    send(res, 404, { error: { message: `No route ${req.method} ${url}` } });
  } catch (error) {
    send(res, 500, { error: { message: String(error) } });
  }
}).listen(PORT, () => console.log(`Fake Meta Model API on http://localhost:${PORT}/v1`));
