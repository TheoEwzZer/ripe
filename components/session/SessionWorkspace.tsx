"use client";

import type { OptimisticLocalStore } from "convex/browser";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { KitchenView } from "@/components/recipes/RecipeCard";
import { RecipePanel } from "@/components/recipes/RecipePanel";
import { recipeLabels } from "@/components/recipes/shared";
import { EditCard } from "@/components/scan/EditCard";
import { IngredientList } from "@/components/scan/IngredientList";
import { ScanCanvas, displayName, type CanvasIngredient, type CanvasMask } from "@/components/scan/ScanCanvas";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { prepareImage } from "@/lib/client/prepare-image";
import { PhoneCard, PresenceBar, usePresence } from "./Presence";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

type T = {
  session: Dictionary["session"];
  scan: Dictionary["scan"];
  freshness: Dictionary["freshness"];
  recipes: Dictionary["recipes"];
  devices: Dictionary["devices"];
};
type Toast = { message: string; undo: () => Promise<unknown> };

const TOAST_MS = 5000;

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

export function SessionWorkspace({ t }: { t: T }) {
  const { id, lang } = useParams<{ id: string; lang: string }>();
  const locale = lang === "fr" ? "fr" : "en";
  const pathname = usePathname();
  const session = useQuery(api.sessions.get, { sessionId: id });
  const recipes = useQuery(api.recipes.latest, { sessionId: id });
  const latest = useQuery(api.scans.latest, { sessionId: id });
  const masks = useQuery(api.scans.masks, latest ? { scanId: latest.scan._id } : "skip");
  const caps = useQuery(api.scans.capabilities);
  const startDemo = useMutation(api.scans.startDemo);
  const generateUploadUrl = useMutation(api.scans.generateUploadUrl);
  const startUpload = useMutation(api.scans.startUpload);
  const tap = useMutation(api.scans.tap);
  const merge = useMutation(api.ingredients.merge);
  const presence = usePresence(session ? session._id : null);
  const unmerge = useMutation(api.ingredients.unmerge);

  // Edits show at once; Convex replaces the guess with the stored value when the write lands.
  type Latest = NonNullable<typeof latest>;
  type Patch = Partial<Pick<Latest["ingredients"][number], "name" | "daysLeft" | "removed">>;
  const patchLocal = (store: OptimisticLocalStore, ingredientId: string, patch: Patch) => {
    const current = store.getQuery(api.scans.latest, { sessionId: id });
    if (!current) return;
    store.setQuery(
      api.scans.latest,
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

  const [busy, setBusy] = useState<"demo" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [tab, setTab] = useState<"inventory" | "recipes">("inventory");
  const [hoveredRecipe, setHoveredRecipe] = useState<ReadonlySet<string> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  if (session === undefined || latest === undefined) {
    return <div className="h-72 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  }
  if (session === null) return <p className="text-ink-soft">{t.session.expired}</p>;

  const sessionId = session._id;
  const running = latest?.scan.status === "perceiving" || latest?.scan.status === "segmenting";
  const live = caps?.live ?? false;
  const phone = presence.me?.kind === "phone";

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

  async function runDemo() {
    setBusy("demo");
    setSelected(null);
    await attempt(() => startDemo({ sessionId }));
    setBusy(null);
  }

  async function runUpload(file: File) {
    setBusy("upload");
    setSelected(null);
    await attempt(async () => {
      const { blob, width, height } = await prepareImage(file);
      const uploadUrl = await generateUploadUrl({ sessionId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: string };
      await startUpload({
        sessionId,
        storageId: storageId as Id<"_storage">,
        width,
        height,
      });
    });
    setBusy(null);
    if (fileInput.current) fileInput.current.value = "";
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
      <section className="glass flex flex-col gap-8 rounded-3xl p-6 sm:p-10 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h1 className="font-display text-4xl font-extrabold tracking-tight wrap-break-word sm:text-5xl">{t.session.startTitle}</h1>
            <p className="max-w-xl text-ink-soft">{t.session.startLead}</p>
          </div>
          {actions(false)}
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

  const { scan } = latest;
  const settled = scan.status === "done" || scan.status === "error";
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
  const visible = latest.ingredients.filter((i) => !i.removed);
  const outlined = ingredients.filter((i) => i.segmentation !== "pending").length;
  const seconds = scan.finishedAt ? ((scan.finishedAt - scan._creationTime) / 1000).toFixed(1) : null;

  // Duplicates: same name once plurals are folded, only once the analysis has settled.
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

  // A recipe under the pointer, or the one open in the sheet, lights its ingredients on the photo.
  const openRecipeId = /\/r\/([^/]+)$/.exec(pathname)?.[1];
  const openRecipe = openRecipeId ? recipes?.recipes.find((r) => r._id === openRecipeId) : undefined;
  const highlight =
    hoveredRecipe ?? (openRecipe ? new Set(openRecipe.uses.flatMap((u) => (u.ingredientId ? [u.ingredientId as string] : []))) : null);
  const kitchen: KitchenView = new Map(visible.map((i) => [i._id as string, { name: i.name, daysLeft: i.daysLeft, bbox: i.bbox }]));
  const canCook = settled && visible.some((i) => i.name.trim() !== "");
  const showRecipes = tab === "recipes" && settled;

  const removeItem = (itemId: string) => {
    const item = latest.ingredients.find((i) => i._id === itemId);
    if (!item) return;
    const ingredientId = item._id;
    if (selected === itemId) setSelected(null);
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
      ? ingredients.length > 0
        ? fill(t.scan.perceivingCount, { n: ingredients.length })
        : t.scan.perceiving
      : scan.status === "segmenting"
        ? fill(t.scan.segmenting, { done: outlined, total: ingredients.length })
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
            {scan.live ? t.scan.liveBadge : t.scan.demoBadge}
            {seconds && ` · ${seconds} s`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PresenceBar presence={presence} sessionId={sessionId} code={session.code} locale={locale} t={t.devices} />
          {actions(true)}
        </div>
      </div>
      {error && (
        <p className="text-sm text-betterave" role="alert">
          {error}
        </p>
      )}
      {canTap && <p className="-mt-2 text-sm text-ink-soft">{t.scan.tapHint}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="lg:sticky lg:top-6">
          <ScanCanvas
            image={{
              src: scan.imageUrl,
              width: scan.width,
              height: scan.height,
            }}
            ingredients={ingredients}
            masks={canvasMasks}
            scanning={running}
            active={active}
            onActive={setActive}
            labels={t.scan}
            onTap={onTap}
            selected={selected}
            onSelect={setSelected}
            highlight={highlight}
          />
        </div>
        {ingredients.length > 0 && (
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
                sessionId={sessionId}
                locale={locale}
                data={recipes}
                pantry={session.pantry}
                canCook={canCook}
                kitchen={kitchen}
                photo={{
                  src: scan.imageUrl,
                  width: scan.width,
                  height: scan.height,
                }}
                recipeHref={(recipeId) => `/${locale}/s/${sessionId}/r/${recipeId}`}
                labels={recipeLabels(t)}
                attempt={attempt}
                onHighlight={setHoveredRecipe}
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
                onMerge={() => mergeInto(current._id)}
                onClose={() => setSelected(null)}
              />
            )}
            {!showRecipes && (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-2">
                  <p className="text-sm text-ink-soft">{t.scan.cookFirst}</p>
                  {duplicateTotal > 0 && firstDuplicate && (
                    <button
                      type="button"
                      onClick={() => setSelected(firstDuplicate)}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {duplicateTotal === 1 ? t.scan.duplicateOne : fill(t.scan.duplicates, { n: duplicateTotal })}
                    </button>
                  )}
                </div>
                <IngredientList
                  ingredients={ingredients}
                  active={active}
                  onActive={setActive}
                  labels={t.scan}
                  selected={selected}
                  onSelect={settled ? setSelected : undefined}
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
