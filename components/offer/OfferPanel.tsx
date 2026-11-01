"use client";

import { useFoodName } from "@/lib/i18n/foods";
import { useMutation, useQuery } from "convex/react";
import { useState, useSyncExternalStore } from "react";
import { Pip, dayLabel } from "@/components/scan/Pip";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

const noSubscribe = () => () => {};

/** Pick what won't be eaten in time, get a link to send; claims show up live. */
export function OfferPanel({
  sessionId,
  locale,
  items,
  t,
  scanLabels,
  onClose,
}: {
  sessionId: Id<"sessions">;
  locale: "en" | "fr";
  items: { _id: Id<"ingredients">; name: string; daysLeft: number }[];
  t: Dictionary["offer"];
  scanLabels: Pick<Dictionary["scan"], "daysLeft" | "today">;
  onClose: () => void;
}) {
  const tr = useFoodName();
  const create = useMutation(api.offers.create);
  const offers = useQuery(api.offers.forSession, { sessionId });
  const origin = useSyncExternalStore(
    noSubscribe,
    () => location.origin,
    () => null,
  );
  // The most urgent items are the likely gifts: they start ticked.
  const ranked = [...items].filter((i) => i.name.trim()).sort((a, b) => a.daysLeft - b.daysLeft);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(ranked.filter((i) => i.daysLeft <= 2).map((i) => i._id)));
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<{ id: string; names: string[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const link = made && origin ? `${origin}/${locale}/o/${made.id}` : null;
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface p-3 ring-1 ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-semibold">{t.title}</p>
          <p className="text-xs text-ink-soft">{t.lead}</p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-sm font-medium underline-offset-4 hover:underline">
          {t.cancel}
        </button>
      </div>

      {!made ? (
        <>
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {ranked.map((item) => (
              <li key={item._id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-glass">
                  <input
                    type="checkbox"
                    checked={picked.has(item._id)}
                    onChange={() => toggle(item._id)}
                    className="size-4 accent-[var(--color-kaki)]"
                  />
                  <Pip daysLeft={item.daysLeft} />
                  <span className="min-w-0 flex-1 truncate">{tr(item.name)}</span>
                  <span className="font-mono text-xs text-ink-soft">{dayLabel(item.daysLeft, scanLabels)}</span>
                </label>
              </li>
            ))}
          </ul>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 140))}
            placeholder={t.notePlaceholder}
            className="rounded-xl bg-glass px-3 py-2 text-sm ring-1 ring-hairline outline-none focus:ring-2 focus:ring-kaki"
          />
          <button
            type="button"
            disabled={picked.size === 0 || picked.size > 10 || pending}
            onClick={async () => {
              setPending(true);
              try {
                const ids = ranked.filter((i) => picked.has(i._id)).map((i) => i._id);
                const id = await create({ sessionId, ingredientIds: ids, note, locale });
                setMade({ id, names: ranked.filter((i) => picked.has(i._id)).map((i) => tr(i.name)) });
              } catch {
                // The list below stays as it was; the button can be pressed again.
              }
              setPending(false);
            }}
            className="rounded-full bg-aubergine px-5 py-2.5 font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 dark:bg-porcelaine dark:text-aubergine"
          >
            {pending ? t.creating : t.create}
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{t.ready}</p>
          {link && <p className="rounded-xl bg-glass px-3 py-2 font-mono text-xs break-all select-all ring-1 ring-hairline">{link}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!link) return;
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                } catch {
                  setCopied(false);
                }
              }}
              className="rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
            >
              {copied ? t.copied : t.copy}
            </button>
            {link && typeof navigator.share === "function" && (
              <button
                type="button"
                onClick={() =>
                  void navigator.share({ url: link, text: fill(t.shareText, { names: made.names.join(", ") }) }).catch(() => {})
                }
                className="rounded-full bg-aubergine px-4 py-2 text-sm font-medium text-porcelaine dark:bg-porcelaine dark:text-aubergine"
              >
                {t.share}
              </button>
            )}
          </div>
        </div>
      )}

      {offers && offers.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-hairline pt-2">
          <p className="text-xs font-medium text-ink-soft">{t.yours}</p>
          {offers.map((offer) => (
            <p key={offer._id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{offer.names.join(", ")}</span>
              <span className={`shrink-0 text-xs ${offer.claimed ? "font-medium text-feuille" : "text-ink-soft"}`}>
                {offer.claimed ? `✓ ${t.claimed}` : t.waiting}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
