"use client";

import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { PhotoButton } from "@/components/session/AddPhoto";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { prepareImage } from "@/lib/client/prepare-image";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

type Result = { found: boolean; text: string; kind: string | null; daysLeft: number | null };

/** "What does the label say?": Muse Spark reads the printed date on the photo, or on a close-up of the label. */
export function DateReader({
  sessionId,
  ingredientId,
  onPhoto,
  phone,
  t,
}: {
  sessionId: Id<"sessions">;
  ingredientId: Id<"ingredients">;
  /** The item was seen on a photo, so its box can be read without a new picture. */
  onPhoto: boolean;
  phone: boolean;
  t: Dictionary["dates"];
}) {
  const readDate = useAction(api.reading.readDate);
  const uploadUrl = useMutation(api.dates.uploadUrl);
  const [state, setState] = useState<"idle" | "reading" | "failed">("idle");
  const [result, setResult] = useState<Result | null>(null);

  const read = async (file?: File) => {
    setState("reading");
    setResult(null);
    try {
      let storageId: Id<"_storage"> | undefined;
      if (file) {
        const { blob } = await prepareImage(file, 1280);
        const url = await uploadUrl({ sessionId });
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
        storageId = ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      setResult(await readDate({ ingredientId, storageId }));
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  const kind = (k: string | null) => (k === "use_by" ? t.useBy : k === "best_before" ? t.bestBefore : k === "packed" ? t.packed : "");
  const days = (n: number) => (n <= 0 ? t.today : n === 1 ? t.oneDay : fill(t.days, { n }));

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-glass p-3 ring-1 ring-hairline">
      <div className="flex flex-wrap items-center gap-2">
        {onPhoto && (
          <button
            type="button"
            disabled={state === "reading"}
            onClick={() => void read()}
            className="rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-surface disabled:opacity-50"
          >
            {t.fromPhoto}
          </button>
        )}
        <PhotoButton label={t.closeUp} camera={phone} compact disabled={state === "reading"} onFile={(file) => void read(file)} />
      </div>
      <p className="text-sm" aria-live="polite">
        {state === "reading" && <span className="text-ink-soft">{t.reading}</span>}
        {state === "failed" && <span className="text-betterave">{t.failed}</span>}
        {state === "idle" &&
          result &&
          (result.found
            ? fill(t.found, { text: result.text, kind: kind(result.kind) }) +
              (result.daysLeft !== null ? ` → ${days(result.daysLeft)}` : "")
            : t.none)}
        {state === "idle" && !result && <span className="text-ink-soft">{t.hint}</span>}
      </p>
    </div>
  );
}
