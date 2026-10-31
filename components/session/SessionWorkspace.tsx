"use client";

import type { OptimisticLocalStore } from "convex/browser";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KitchenView } from "@/components/recipes/RecipeCard";
import { RecipePanel } from "@/components/recipes/RecipePanel";
import { recipeLabels } from "@/components/recipes/shared";
import { ImpactStrip } from "@/components/impact/ImpactStrip";
import { RemindMe } from "@/components/reminders/RemindMe";
import { TipCard, TipsPanel } from "@/components/tips/TipsPanel";
import { OfferPanel } from "@/components/offer/OfferPanel";
import { DateReader } from "@/components/scan/DateReader";
import { EditCard } from "@/components/scan/EditCard";
import { IngredientList } from "@/components/scan/IngredientList";
import { ScanCanvas, displayName, type CanvasIngredient, type CanvasMask } from "@/components/scan/ScanCanvas";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { prepareImage, previewOf } from "@/lib/client/prepare-image";
import { firstFrame } from "@/lib/client/video";
import { VideoTracks } from "@/components/scan/VideoTracks";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { AddPhoto, IncomingPhoto, PhotoButton, PhotoStrip, placeLabel, type Place } from "./AddPhoto";
import { VoiceButton } from "@/components/voice/VoiceButton";
import { PhoneCard, PresenceBar, usePresence } from "./Presence";

type T = {
  session: Dictionary["session"];
  scan: Dictionary["scan"];
  freshness: Dictionary["freshness"];
  recipes: Dictionary["recipes"];
  devices: Dictionary["devices"];
  offer: Dictionary["offer"];
  voice: Dictionary["voice"];
  dates: Dictionary["dates"];
  impact: Dictionary["impact"];
  tips: Dictionary["tips"];
  reminders: Dictionary["reminders"];
};
type Toast = { message: string; undo: () => Promise<unknown> };

const TOAST_MS = 5000;
const MAX_VIDEO_SECONDS = 15;

function errorText(error: unknown, { session: t, recipes }: T): string {
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
    case "busy":
      return t.errBusy;
    case "recording":
      return t.errNoDemo;
    case "empty":
      return recipes.errEmpty;
    default:
      return t.errGeneric;
  }
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** "Tomatoes" and "tomato" are the same item; "cherry tomato" is not. */
const nameKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/(es|s)$/, "");

const analysing = (status: string) => status === "perceiving" || status === "segmenting";

export function SessionWorkspace({ t }: { t: T }) {
  const { id, lang } = useParams<{ id: string; lang: string }>();
  const locale = lang === "fr" ? "fr" : "en";
  const pathname = usePathname();
  const session = useQuery(api.sessions.get, { sessionId: id });
  const recipes = useQuery(api.recipes.latest, { sessionId: id });
  const kitchen = useQuery(api.scans.kitchen, { sessionId: id });
  const caps = useQuery(api.scans.capabilities);
  const tipsData = useQuery(api.tips.forSession, { sessionId: id, locale });
  const startDemo = useMutation(api.scans.startDemo);
  const generateUploadUrl = useMutation(api.scans.generateUploadUrl);
  const startUpload = useMutation(api.scans.startUpload);
  const startVideo = useMutation(api.scans.startVideo);
  const retrack = useMutation(api.scans.retrack);
  const tap = useMutation(api.scans.tap);
  const merge = useMutation(api.ingredients.merge);
  const unmerge = useMutation(api.ingredients.unmerge);
  const announcePhoto = useMutation(api.sessions.announcePhoto);
  const clearIncoming = useMutation(api.sessions.clearIncoming);
  const receiptUploadUrl = useMutation(api.dates.uploadUrl);
  const readReceipt = useAction(api.reading.readReceipt);
  const undoVoice = useMutation(api.voice.undo);
  const waste = useMutation(api.impact.waste);
  const unwaste = useMutation(api.impact.unwaste);
  const presence = usePresence(session ? session._id : null);

  // Edits show at once; Convex replaces the guess with the stored value when the write lands.
  type Kitchen = NonNullable<typeof kitchen>;
  type Patch = Partial<Pick<Kitchen["ingredients"][number], "name" | "daysLeft" | "removed">>;
  const patchLocal = (store: OptimisticLocalStore, ingredientId: string, patch: Patch) => {
    const current = store.getQuery(api.scans.kitchen, { sessionId: id });
    if (!current) return;
    store.setQuery(
      api.scans.kitchen,
      { sessionId: id },
      {
        ...current,
        ingredients: current.ingredients.map((i) => (i._id === ingredientId ? { ...i, ...patch } : i)),
      },
    );
  };
  const update = useMutation(api.ingredients.update).withOptimisticUpdate((store, { ingredientId, name, daysLeft }) =>
    patchLocal(store, ingredientId, {
      ...(name === undefined ? {} : { name }),
      ...(daysLeft === undefined ? {} : { daysLeft }),
    }),
  );
  const remove = useMutation(api.ingredients.remove).withOptimisticUpdate((store, { ingredientId }) =>
    patchLocal(store, ingredientId, { removed: true }),
  );
  const restore = useMutation(api.ingredients.restore).withOptimisticUpdate((store, { ingredientId }) =>
    patchLocal(store, ingredientId, { removed: false }),
  );

  const [busy, setBusy] = useState<"demo" | "upload" | "receipt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [tab, setTab] = useState<"inventory" | "recipes">("inventory");
  const [hoveredRecipe, setHoveredRecipe] = useState<ReadonlySet<string> | null>(null);
  const [chosenScan, setChosenScan] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [offering, setOffering] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const allScans = kitchen?.scans ?? [];
  const scans = allScans.filter((s) => !s.list);
  const listOf = new Map(allScans.flatMap((s) => (s.list ? [[s._id as string, s.list] as const] : [])));
  const all = kitchen?.ingredients ?? [];
  const byId = new Map(all.map((i) => [i._id as string, i]));

  // A recipe open in the sheet shows the photo holding most of its ingredients.
  const openRecipeId = /\/r\/([^/]+)$/.exec(pathname)?.[1];
  const openRecipe = openRecipeId ? recipes?.recipes.find((r) => r._id === openRecipeId) : undefined;
  const recipeScan = (() => {
    if (!openRecipe) return undefined;
    const counts = new Map<string, number>();
    for (const use of openRecipe.uses) {
      const scanId = use.ingredientId && byId.get(use.ingredientId)?.scanId;
      if (scanId) counts.set(scanId, (counts.get(scanId) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  })();
  const scan =
    scans.find((s) => analysing(s.status)) ??
    scans.find((s) => s._id === recipeScan) ??
    scans.find((s) => s._id === chosenScan) ??
    scans.at(-1);
  const masks = useQuery(api.scans.masks, scan ? { scanId: scan._id } : "skip");
  const tracks = useQuery(api.scans.tracks, scan?.video?.tracking === "done" ? { scanId: scan._id } : "skip");
  const [watching, setWatching] = useState(false);

  if (session === undefined || kitchen === undefined) {
    return <div className="h-72 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  }
  if (session === null) return <p className="text-ink-soft">{t.session.expired}</p>;

  const sessionId = session._id;
  const running = allScans.some((s) => analysing(s.status));
  const live = caps?.live ?? false;
  const phone = presence.me?.kind === "phone";
  const usedDemos = new Set(scans.flatMap((s) => (s.recordingId ? [s.recordingId] : [])));
  const demoLeft = scans.length > 0 && scans.every((s) => !s.live) && (caps?.demos ?? []).some((d) => !usedDemos.has(d));

  const showToast = (next: Toast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const attempt = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  async function runDemo(fresh: boolean, place?: Place) {
    setBusy("demo");
    setSelected(null);
    setChosenScan(null);
    setAdding(false);
    if (fresh) setTab("inventory");
    await attempt(() => startDemo({ sessionId, fresh, place }));
    setBusy(null);
  }

  async function runReceipt(file: File) {
    setBusy("receipt");
    setAdding(false);
    await attempt(async () => {
      // Receipts are tall and the print is small: keep more pixels than a fridge photo.
      const { blob } = await prepareImage(file, 2200);
      const url = await receiptUploadUrl({ sessionId });
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const { added } = await readReceipt({ sessionId, storageId });
      if (added.length === 0) {
        setError(t.session.receiptNone);
        return;
      }
      showToast({
        message: fill(t.session.receiptAdded, { n: added.length }),
        undo: () => undoVoice({ sessionId, added: added.map((a) => a.id), removed: [] }),
      });
    });
    setBusy(null);
  }

  async function runVideo(file: File, place: Place) {
    setBusy("upload");
    setSelected(null);
    setChosenScan(null);
    setAdding(false);
    await attempt(async () => {
      const clip = await firstFrame(file);
      if (clip.duration > MAX_VIDEO_SECONDS + 0.5) {
        setError(fill(t.session.videoTooLong, { n: MAX_VIDEO_SECONDS }));
        return;
      }
      const upload = async (blob: Blob) => {
        const url = await generateUploadUrl({ sessionId });
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
        return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
      };
      const [frameId, videoId] = await Promise.all([upload(clip.frame), upload(file)]);
      await startVideo({
        sessionId,
        storageId: frameId,
        width: clip.width,
        height: clip.height,
        place,
        video: { storageId: videoId, width: clip.videoWidth, height: clip.videoHeight, duration: clip.duration },
      });
    });
    setBusy(null);
  }

  async function runUpload(file: File, place: Place) {
    setBusy("upload");
    setSelected(null);
    setChosenScan(null);
    setAdding(false);
    let announced = false;
    await attempt(async () => {
      // The blurred thumbnail goes first: the computer shows it before the photo is even uploaded.
      try {
        await announcePhoto({ sessionId, ...(await previewOf(file)) });
        announced = true;
      } catch {
        // Only a nicety: the upload goes on without it.
      }
      const { blob, width, height } = await prepareImage(file);
      const uploadUrl = await generateUploadUrl({ sessionId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: string };
      await startUpload({ sessionId, storageId: storageId as Id<"_storage">, width, height, place });
      announced = false;
    });
    if (announced) void clearIncoming({ sessionId }).catch(() => {});
    setBusy(null);
  }

  const incoming = session.incoming;

  if (!kitchen || !scan) {
    if (incoming) {
      return (
        <section className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <IncomingPhoto photo={incoming} label={t.session.incoming} large />
        </section>
      );
    }
    return (
      <section className="glass flex flex-col gap-8 rounded-3xl p-6 sm:p-10 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 className="font-display text-4xl font-extrabold tracking-tight wrap-break-word sm:text-5xl">{t.session.startTitle}</h1>
            <p className="max-w-xl text-ink-soft">{t.session.startLead}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {phone && (
              <PhotoButton
                label={busy === "upload" ? t.session.uploading : t.session.scanFridge}
                camera
                primary
                disabled={!live || busy !== null}
                onFile={(file) => void runUpload(file, "fridge")}
              />
            )}
            <button
              type="button"
              onClick={() => void runDemo(true)}
              disabled={busy !== null}
              className={`rounded-full px-6 py-3 font-medium transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-50 ${
                phone
                  ? "ring-1 ring-hairline hover:bg-glass"
                  : "bg-aubergine text-porcelaine hover:opacity-90 dark:bg-porcelaine dark:text-aubergine"
              }`}
            >
              {t.session.demo}
            </button>
            {!phone && (
              <PhotoButton
                label={busy === "upload" ? t.session.uploading : t.session.upload}
                camera={false}
                disabled={!live || busy !== null}
                onFile={(file) => void runUpload(file, "fridge")}
              />
            )}
            {live && (
              <PhotoButton
                label={t.session.filmFridge}
                camera={phone}
                accept="video/mp4,video/quicktime"
                disabled={busy !== null}
                onFile={(file) => void runVideo(file, "fridge")}
              />
            )}
          </div>
          {!live && <p className="max-w-xl text-sm text-ink-soft">{t.session.liveOff}</p>}
          {error && (
            <p className="text-sm text-betterave" role="alert">
              {error}
            </p>
          )}
          {phone ? (
            <PresenceBar presence={presence} sessionId={sessionId} code={session.code} locale={locale} t={t.devices} />
          ) : (
            <p className="text-sm text-ink-soft">
              {t.session.code} <span className="font-mono text-ink">{session.code}</span>
            </p>
          )}
        </div>
        {!phone && <PhoneCard presence={presence} sessionId={sessionId} code={session.code} locale={locale} t={t.devices} />}
      </section>
    );
  }

  const settled = !running;
  const visible = all.filter((i) => !i.removed);
  // "Fridge", or "Fridge 1" and "Fridge 2" when two photos share a place.
  const scanLabels = new Map(
    scans.map((s) => {
      const same = scans.filter((o) => o.place === s.place);
      const label = placeLabel(s.place, t.session);
      return [s._id as string, same.length > 1 ? `${label} ${same.indexOf(s) + 1}` : label];
    }),
  );

  // The shown photo's items. A duplicate folded into an item seen on another photo stays drawn here, as that item.
  const aliasOf = new Map<string, string>();
  const ingredients: CanvasIngredient[] = all
    .filter((i) => i.scanId === scan._id)
    .map((i) => {
      const keep = i.mergedInto ? byId.get(i.mergedInto) : undefined;
      if (keep && keep.scanId !== i.scanId && !keep.removed) {
        aliasOf.set(i._id, keep._id);
        return { key: i._id, name: keep.name, daysLeft: keep.daysLeft, bbox: i.bbox, segmentation: i.segmentation, removed: false };
      }
      return { key: i._id, name: i.name, daysLeft: i.daysLeft, bbox: i.bbox, segmentation: i.segmentation, removed: i.removed };
    });
  const listed: CanvasIngredient[] = visible.map((i) => ({
    key: i._id,
    name: i.name,
    daysLeft: i.daysLeft,
    bbox: i.bbox,
    segmentation: i.segmentation,
    offPhoto: listOf.has(i.scanId),
    tag: listOf.has(i.scanId)
      ? listOf.get(i.scanId) === "voice"
        ? t.voice.spokenTag
        : t.voice.receiptTag
      : scans.length > 1
        ? scanLabels.get(i.scanId)
        : undefined,
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
  const counts = new Map<string, number>();
  for (const i of visible) counts.set(i.scanId, (counts.get(i.scanId) ?? 0) + 1);
  const shownItems = ingredients.filter((i) => !i.removed);
  const outlined = shownItems.filter((i) => i.segmentation !== "pending").length;
  const seconds = scan.finishedAt ? ((scan.finishedAt - scan._creationTime) / 1000).toFixed(1) : null;

  // Duplicates: same name once plurals are folded, across every photo, once the analysis has settled.
  const groups = new Map<string, Id<"ingredients">[]>();
  if (settled) {
    for (const item of visible) {
      if (!item.name) continue;
      const key = nameKey(item.name);
      groups.set(key, [...(groups.get(key) ?? []), item._id]);
    }
  }
  const duplicatesOf = (itemId: string) => {
    const item = visible.find((i) => i._id === itemId);
    return item?.name ? (groups.get(nameKey(item.name)) ?? []).filter((other) => other !== itemId) : [];
  };
  const duplicateTotal = [...groups.values()].reduce((sum, ids) => sum + Math.max(0, ids.length - 1), 0);
  const firstDuplicate = [...groups.values()].find((ids) => ids.length > 1)?.[0] ?? null;

  const current = visible.find((i) => i._id === selected) ?? null;
  const select = (key: string | null) => {
    const target = key ? (aliasOf.get(key) ?? key) : null;
    setSelected(target);
    const item = target ? byId.get(target) : undefined;
    if (item && item.scanId !== scan._id && !aliasOf.has(key ?? "")) setChosenScan(item.scanId);
  };

  // A recipe under the pointer, or the one open in the sheet, lights its ingredients on the photo.
  const lit =
    hoveredRecipe ?? (openRecipe ? new Set(openRecipe.uses.flatMap((u) => (u.ingredientId ? [u.ingredientId as string] : []))) : null);
  // Aliases light up with the item they were folded into.
  const highlight = lit ? new Set([...lit, ...[...aliasOf].filter(([, keep]) => lit.has(keep)).map(([alias]) => alias)]) : null;
  const kitchenView: KitchenView = new Map(
    visible.map((i) => [i._id as string, { name: i.name, daysLeft: i.daysLeft, bbox: i.bbox, scanId: i.scanId as string }]),
  );
  const photos = new Map(scans.map((s) => [s._id as string, { src: s.imageUrl, width: s.width, height: s.height }]));
  const canCook = settled && visible.some((i) => i.name.trim() !== "");
  const showRecipes = tab === "recipes" && settled;

  const removeItem = (itemId: string) => {
    const item = byId.get(aliasOf.get(itemId) ?? itemId);
    if (!item) return;
    const ingredientId = item._id;
    if (selected === ingredientId) setSelected(null);
    void attempt(async () => {
      await remove({ ingredientId });
      showToast({
        message: fill(t.scan.removedToast, { name: displayName(item, t.scan) }),
        undo: () => restore({ ingredientId }),
      });
    });
  };

  const mergeInto = (keepId: Id<"ingredients">) => {
    const duplicateIds = duplicatesOf(keepId);
    const keep = visible.find((i) => i._id === keepId);
    if (!keep || duplicateIds.length === 0) return;
    void attempt(async () => {
      await merge({ keepId, duplicateIds });
      showToast({
        message: fill(t.scan.mergedToast, { name: keep.name }),
        undo: () => unmerge({ keepId }),
      });
    });
  };

  // Adding by touch needs the live API and a finished analysis (item order and boxes are settled).
  const canTap = live && settled;
  const onTap = canTap ? (point: { x: number; y: number }) => void attempt(() => tap({ scanId: scan._id, ...point })) : undefined;

  const status =
    scan.status === "perceiving"
      ? shownItems.length > 0
        ? fill(t.scan.perceivingCount, { n: shownItems.length })
        : t.scan.perceiving
      : scan.status === "segmenting"
        ? fill(t.scan.segmenting, { done: outlined, total: shownItems.length })
        : scan.status === "error"
          ? fill(t.scan.failed, { message: scan.error ?? "" })
          : fill(t.scan.done, { total: visible.length });

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite">
          <p className={`font-display text-2xl font-semibold tracking-tight ${scan.status === "error" ? "text-betterave" : ""}`}>
            {status}
          </p>
          <p className="font-mono text-xs text-ink-soft">
            {scans.length > 1 && settled ? `${fill(t.session.photosCount, { n: scans.length })} · ` : ""}
            {scan.live ? t.scan.liveBadge : t.scan.demoBadge}
            {seconds && ` · ${seconds} s`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PresenceBar presence={presence} sessionId={sessionId} code={session.code} locale={locale} t={t.devices} />
          {live && settled && (
            <VoiceButton
              sessionId={sessionId}
              locale={locale}
              t={t.voice}
              onHeard={(heard) => {
                if (heard.runStarted) setTab("recipes");
              }}
            />
          )}
          <button
            type="button"
            aria-expanded={adding}
            onClick={() => setAdding((a) => !a)}
            disabled={busy !== null || running}
            className="rounded-full bg-aubergine px-4 py-2 text-sm font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 dark:bg-porcelaine dark:text-aubergine"
          >
            {busy === "upload" ? t.session.uploading : busy === "receipt" ? t.session.receiptReading : t.session.addPhoto}
          </button>
          <button
            type="button"
            onClick={() => void runDemo(true)}
            disabled={busy !== null || running}
            className="rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-[transform,opacity] duration-150 hover:bg-glass active:scale-[0.98] disabled:opacity-50"
          >
            {t.session.replayAgain}
          </button>
        </div>
      </div>
      {adding && (
        <AddPhoto
          t={t.session}
          live={live}
          phone={phone}
          demoLeft={demoLeft}
          disabled={busy !== null || running}
          onDemo={() => void runDemo(false)}
          onFile={(file, place) => void runUpload(file, place)}
          onReceipt={(file) => void runReceipt(file)}
          onVideo={(file, place) => void runVideo(file, place)}
          onClose={() => setAdding(false)}
        />
      )}
      {error && (
        <p className="text-sm text-betterave" role="alert">
          {error}
        </p>
      )}
      {canTap && <p className="-mt-2 text-sm text-ink-soft">{t.scan.tapHint}</p>}
      {incoming && <IncomingPhoto photo={incoming} label={t.session.incoming} large={false} />}

      {settled && <ImpactStrip sessionId={sessionId} locale={locale} live={live} t={t.impact} />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex flex-col gap-3 lg:sticky lg:top-6">
          {scans.length > 1 && (
            <PhotoStrip
              scans={scans}
              shown={scan._id}
              counts={counts}
              labels={scanLabels}
              t={t.session}
              onShow={(scanId) => {
                setChosenScan(scanId);
                setSelected(null);
              }}
            />
          )}
          {scan.video && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-ink-soft" aria-live="polite">
                {scan.video.tracking === "done"
                  ? t.session.tracked
                  : scan.video.tracking === "failed"
                    ? t.session.trackFailed
                    : t.session.tracking}
              </p>
              {scan.video.tracking === "failed" && (
                <button
                  type="button"
                  onClick={() => void attempt(() => retrack({ scanId: scan._id }))}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {t.session.retrack}
                </button>
              )}
              {scan.video.tracking === "done" && (
                <button type="button" onClick={() => setWatching((w) => !w)} className="font-medium underline-offset-4 hover:underline">
                  {watching ? t.session.backToPhoto : t.session.watchScan}
                </button>
              )}
            </div>
          )}
          {watching && scan.video?.url && scan.video.frames && tracks ? (
            <VideoTracks
              video={{
                url: scan.video.url,
                width: scan.video.width,
                height: scan.video.height,
                duration: scan.video.duration,
                frames: scan.video.frames,
              }}
              tracks={tracks}
              items={new Map(all.map((i) => [i._id as string, { name: i.name, daysLeft: i.daysLeft }]))}
            />
          ) : (
            <ScanCanvas
              key={scan._id}
              image={{ src: scan.imageUrl, width: scan.width, height: scan.height }}
              ingredients={ingredients}
              masks={canvasMasks}
              scanning={analysing(scan.status)}
              active={active}
              onActive={setActive}
              labels={t.scan}
              onTap={onTap}
              selected={selected}
              onSelect={select}
              highlight={highlight}
            />
          )}
        </div>
        {visible.length > 0 && (
          <aside className="glass flex flex-col gap-3 rounded-3xl p-4">
            {settled && (
              <div className="grid grid-cols-2 gap-1 rounded-full bg-surface p-1 ring-1 ring-hairline" role="tablist">
                {(["inventory", "recipes"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => {
                      setTab(key);
                      setSelected(null);
                    }}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      tab === key ? "bg-aubergine text-porcelaine dark:bg-porcelaine dark:text-aubergine" : "text-ink-soft hover:text-ink"
                    }`}
                  >
                    {key === "inventory" ? `${t.recipes.inventoryTab} · ${visible.length}` : t.recipes.recipesTab}
                  </button>
                ))}
              </div>
            )}
            {showRecipes && recipes !== undefined && (
              <RecipePanel
                key={recipes?.run._id ?? "none"}
                sessionId={sessionId}
                locale={locale}
                data={recipes}
                pantry={session.pantry}
                canCook={canCook}
                kitchen={kitchenView}
                photos={photos}
                recipeHref={(recipeId) => `/${locale}/s/${sessionId}/r/${recipeId}`}
                labels={recipeLabels(t)}
                attempt={attempt}
                onHighlight={setHoveredRecipe}
              />
            )}
            {!showRecipes && keeping && (
              <TipsPanel sessionId={sessionId} locale={locale} items={visible} t={t.tips} onClose={() => setKeeping(false)} />
            )}
            {!showRecipes && offering && (
              <OfferPanel
                sessionId={sessionId}
                locale={locale}
                items={visible}
                t={t.offer}
                scanLabels={t.scan}
                onClose={() => setOffering(false)}
              />
            )}
            {!showRecipes && current && (
              <EditCard
                key={current._id}
                item={{ ...current, key: current._id }}
                duplicateCount={duplicatesOf(current._id).length}
                labels={{ ...t.scan, tiers: t.freshness }}
                onRename={(name) => void attempt(() => update({ ingredientId: current._id, name }))}
                onDays={(daysLeft) => void attempt(() => update({ ingredientId: current._id, daysLeft }))}
                onRemove={() => removeItem(current._id)}
                wasteLabel={t.impact.waste}
                onWaste={() => {
                  const ingredientId = current._id;
                  setSelected(null);
                  void attempt(async () => {
                    await waste({ ingredientId });
                    showToast({ message: fill(t.impact.wastedToast, { name: current.name }), undo: () => unwaste({ ingredientId }) });
                  });
                }}
                onMerge={() => mergeInto(current._id)}
                onClose={() => setSelected(null)}
              >
                {tipsData?.status === "ready" &&
                  (() => {
                    const tip = tipsData.tips.find((x) => x.item === current.name);
                    return tip ? <TipCard tip={tip} daysLeft={current.daysLeft} t={t.tips} /> : null;
                  })()}
                {live && (
                  <DateReader
                    key={current._id}
                    sessionId={sessionId}
                    ingredientId={current._id}
                    onPhoto={!listOf.has(current.scanId)}
                    phone={phone}
                    t={t.dates}
                  />
                )}
              </EditCard>
            )}
            {!showRecipes && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-2">
                  <p className="text-sm text-ink-soft">{t.scan.cookFirst}</p>
                  {duplicateTotal > 0 && firstDuplicate && (
                    <button
                      type="button"
                      onClick={() => select(firstDuplicate)}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {duplicateTotal === 1 ? t.scan.duplicateOne : fill(t.scan.duplicates, { n: duplicateTotal })}
                    </button>
                  )}
                </div>
                <IngredientList
                  ingredients={listed}
                  active={active}
                  onActive={setActive}
                  labels={t.scan}
                  selected={selected}
                  onSelect={settled ? select : undefined}
                  onRemove={settled ? removeItem : undefined}
                />
                {settled && !current && <p className="px-2 text-xs text-ink-soft">{t.scan.selectHint}</p>}
                {canCook && (
                  <button
                    type="button"
                    onClick={() => {
                      setTab("recipes");
                      setSelected(null);
                    }}
                    className="rounded-full bg-aubergine px-5 py-2.5 font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] dark:bg-porcelaine dark:text-aubergine"
                  >
                    {t.recipes.seeRecipes}
                  </button>
                )}
                {settled && <RemindMe sessionId={sessionId} locale={locale} t={t.reminders} />}
                {settled && !keeping && (
                  <button
                    type="button"
                    onClick={() => {
                      setKeeping(true);
                      setSelected(null);
                    }}
                    className="rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
                  >
                    {t.tips.open}
                  </button>
                )}
                {settled && !offering && (
                  <button
                    type="button"
                    onClick={() => {
                      setOffering(true);
                      setSelected(null);
                    }}
                    className="rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
                  >
                    {t.offer.open}
                  </button>
                )}
              </>
            )}
          </aside>
        )}
      </div>

      {toast && (
        <div
          role="status"
          className="fixed inset-x-0 z-20 flex justify-center px-4"
          style={{ bottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center gap-3 rounded-full bg-aubergine py-2 pr-2 pl-4 text-sm text-porcelaine shadow-lg dark:bg-porcelaine dark:text-aubergine">
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => {
                const { undo } = toast;
                setToast(null);
                void attempt(undo);
              }}
              className="rounded-full bg-porcelaine/15 px-3 py-1.5 font-medium transition-colors hover:bg-porcelaine/25 dark:bg-aubergine/10 dark:hover:bg-aubergine/20"
            >
              {t.scan.undo}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
