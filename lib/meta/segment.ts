import { buildObjectPrompt, parseImageStream, type ImageSegmentationResult, type PromptPoint } from "@meta-sam/parser";
import { metaClient } from "./client";
import { MODELS } from "./models";

export type MaskEncoding = "lossless" | "one_bit";

export type SegmentResult = {
  prompt: string;
  rawText: string;
  result: ImageSegmentationResult;
  ms: number;
};

async function run(imageUrl: string, inputText: string, encoding: MaskEncoding): Promise<SegmentResult> {
  const started = Date.now();
  const stream = await metaClient().responses.create({
    model: MODELS.segment,
    stream: true,
    metadata: { include_confidence: "true", mask_encoding: encoding },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: inputText },
          { type: "input_image", image_url: imageUrl, detail: "auto" },
        ],
      },
    ],
  });

  const result = await parseImageStream(stream).finalResult;
  return { prompt: inputText, rawText: result.rawOutput, result, ms: Date.now() - started };
}

/** SAM 3.1 takes exactly one short noun phrase per request; callers fan out one request per ingredient. */
export function segmentConcept(imageUrl: string, nounPhrase: string, encoding: MaskEncoding = "one_bit") {
  return run(imageUrl, nounPhrase, encoding);
}

/** Box prompts (up to 16 objects) built with buildObjectPrompt; the API always answers in one_bit. */
export function segmentBoxes(imageUrl: string, objectPrompt: string) {
  return run(imageUrl, objectPrompt, "one_bit");
}

/** "Tap to add": a positive point on something the perception step missed. */
export function segmentPoint(
  imageUrl: string,
  size: { width: number; height: number },
  point: PromptPoint,
) {
  const text = buildObjectPrompt({ size, objects: [{ id: 0, prompts: [{ points: [point] }] }] });
  return run(imageUrl, text, "one_bit");
}
