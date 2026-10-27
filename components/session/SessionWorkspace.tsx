"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { IngredientList } from "@/components/scan/IngredientList";
import { ScanCanvas, type CanvasIngredient, type CanvasMask } from "@/components/scan/ScanCanvas";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { prepareImage } from "@/lib/client/prepare-image";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

type T = { session: Dictionary["session"]; scan: Dictionary["scan"] };

function errorText(error: unknown, t: T["session"]): string {
  const code = error instanceof ConvexError ? (error.data as { code?: string }).code : undefined;
  switch (code) {
    case "quota":
      return t.errQuota;
    case "budget":
      return t.errBudget;
    case "upload":
      return t.errUpload;
    case "live_disabled":
      return t.errLive;
    case "session":
      return t.errSession;
    default:
      return t.errGeneric;
  }
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

export function SessionWorkspace({ t }: { t: T }) {
  const { id } = useParams<{ id: string }>();
  const session = useQuery(api.sessions.get, { sessionId: id });
  const latest = useQuery(api.scans.latest, { sessionId: id });
  const masks = useQuery(api.scans.masks, latest ? { scanId: latest.scan._id } : "skip");
  const caps = useQuery(api.scans.capabilities);
  const startDemo = useMutation(api.scans.startDemo);
  const generateUploadUrl = useMutation(api.scans.generateUploadUrl);
  const startUpload = useMutation(api.scans.startUpload);

  const [busy, setBusy] = useState<"demo" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (session === undefined || latest === undefined) {
    return <div className="h-72 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  }
  if (session === null) return <p className="text-ink-soft">{t.session.expired}</p>;

  const sessionId = session._id;
  const running = latest?.scan.status === "perceiving" || latest?.scan.status === "segmenting";
  const live = caps?.live ?? false;

  async function runDemo() {
    setBusy("demo");
    setError(null);
    try {
      await startDemo({ sessionId });
    } catch (e) {
      setError(errorText(e, t.session));
    } finally {
      setBusy(null);
    }
  }

  async function runUpload(file: File) {
    setBusy("upload");
    setError(null);
    try {
      const { blob, width, height } = await prepareImage(file);
      const uploadUrl = await generateUploadUrl({ sessionId });
      const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: string };
      await startUpload({ sessionId, storageId: storageId as Id<"_storage">, width, height });
    } catch (e) {
      setError(errorText(e, t.session));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const actions = (compact: boolean) => (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={runDemo}
        disabled={busy !== null || running}
        className={`rounded-full font-medium transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-50 ${
          compact
            ? "px-4 py-2 text-sm ring-1 ring-hairline hover:bg-glass"
            : "bg-aubergine px-6 py-3 text-porcelaine hover:opacity-90 dark:bg-porcelaine dark:text-aubergine"
        }`}
      >
        {latest ? t.session.replayAgain : t.session.demo}
      </button>
      <label
        className={`rounded-full font-medium ring-1 ring-hairline transition-colors ${compact ? "px-4 py-2 text-sm" : "px-6 py-3"} ${
          live && busy === null && !running ? "cursor-pointer hover:bg-glass" : "cursor-not-allowed opacity-50"
        }`}
      >
        {busy === "upload" ? t.session.uploading : latest ? t.session.another : t.session.upload}
        <input
          ref={fileInput}
          type="file"
          // Leaving HEIC out makes iOS hand over a JPEG.
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={!live || busy !== null || running}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void runUpload(file);
          }}
        />
      </label>
    </div>
  );

  if (!latest) {
    return (
      <section className="glass flex flex-col gap-6 rounded-3xl p-6 sm:p-10">
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-4xl font-extrabold tracking-tight wrap-break-word sm:text-5xl">{t.session.startTitle}</h1>
          <p className="max-w-xl text-ink-soft">{t.session.startLead}</p>
        </div>
        {actions(false)}
        {!live && <p className="max-w-xl text-sm text-ink-soft">{t.session.liveOff}</p>}
        {error && <p className="text-sm text-betterave" role="alert">{error}</p>}
        <p className="text-sm text-ink-soft">
          {t.session.code} <span className="font-mono text-ink">{session.code}</span>
        </p>
      </section>
    );
  }

  const { scan } = latest;
  const ingredients: CanvasIngredient[] = latest.ingredients.map((i) => ({
    key: i._id,
    name: i.name,
    daysLeft: i.daysLeft,
    bbox: i.bbox,
    segmentation: i.segmentation,
    removed: i.removed,
  }));
  const canvasMasks: CanvasMask[] = (masks ?? []).map((m) => ({
    key: m._id,
    ingredientKey: m.ingredientId,
    encoding: m.encoding,
    payload: m.payload,
    width: m.width,
    height: m.height,
    bounds: m.bounds,
  }));
  const outlined = ingredients.filter((i) => i.segmentation !== "pending").length;
  const seconds = scan.finishedAt ? ((scan.finishedAt - scan._creationTime) / 1000).toFixed(1) : null;

  const status =
    scan.status === "perceiving"
      ? t.scan.perceiving
      : scan.status === "segmenting"
        ? fill(t.scan.segmenting, { done: outlined, total: ingredients.length })
        : scan.status === "error"
          ? fill(t.scan.failed, { message: scan.error ?? "" })
          : fill(t.scan.done, { total: ingredients.length });

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite">
          <p className={`font-display text-2xl font-semibold tracking-tight ${scan.status === "error" ? "text-betterave" : ""}`}>{status}</p>
          <p className="font-mono text-xs text-ink-soft">
            {scan.live ? t.scan.liveBadge : t.scan.demoBadge}
            {seconds && ` · ${seconds} s`}
          </p>
        </div>
        {actions(true)}
      </div>
      {error && <p className="text-sm text-betterave" role="alert">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <ScanCanvas
          image={{ src: scan.imageUrl, width: scan.width, height: scan.height }}
          ingredients={ingredients}
          masks={canvasMasks}
          scanning={running}
          active={active}
          onActive={setActive}
          labels={t.scan}
        />
        {ingredients.length > 0 && (
          <aside className="glass rounded-3xl p-4">
            <p className="px-2 pb-3 text-sm text-ink-soft">{t.scan.cookFirst}</p>
            <IngredientList ingredients={ingredients} active={active} onActive={setActive} labels={t.scan} />
          </aside>
        )}
      </div>
    </section>
  );
}
