"use client";

import { useMutation, useQuery } from "convex/react";
import QRCode from "qrcode";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { deviceKey, deviceKind } from "@/lib/client/device";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const PING_MS = 15_000;
/** A screen that missed two pings is gone (closed tab, locked phone). */
const ONLINE_MS = 40_000;

export type Presence = {
  me: { id: Id<"devices">; kind: "desktop" | "phone" } | null;
  phones: number;
  desktops: number;
};

/** Pings the session while this screen is open and counts the other screens online. */
export function usePresence(sessionId: Id<"sessions"> | null): Presence {
  const ping = useMutation(api.devices.ping);
  const devices = useQuery(api.devices.list, sessionId ? { sessionId } : "skip");
  const [me, setMe] = useState<Presence["me"]>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sessionId) return;
    const key = deviceKey();
    const kind = deviceKind();
    let stopped = false;
    const beat = () =>
      void ping({ sessionId, key, kind })
        .then((id) => {
          if (!stopped) setMe({ id, kind });
        })
        .catch(() => {});
    beat();
    const timer = setInterval(beat, PING_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, ping]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const others = (devices ?? []).filter((d) => d._id !== me?.id && now - d.lastSeen < ONLINE_MS);
  return { me, phones: others.filter((d) => d.kind === "phone").length, desktops: others.filter((d) => d.kind === "desktop").length };
}

/** Phones online in the session, for screens that only need the count (the recipe sheet). */
export function usePhonesOnline(sessionId: string): number {
  const devices = useQuery(api.devices.list, { sessionId });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return (devices ?? []).filter((d) => d.kind === "phone" && now - d.lastSeen < ONLINE_MS).length;
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The session link as a QR code, drawn in the brand ink on white so every camera reads it. */
export function SessionQr({ url, label, className = "" }: { url: string; label: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { margin: 1, errorCorrectionLevel: "M", color: { dark: "#2a1630", light: "#ffffff" } })
      .then((s) => {
        if (live) setSvg(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div
      role="img"
      aria-label={label}
      className={`aspect-square rounded-2xl bg-white p-2 [&>svg]:size-full ${svg ? "" : "animate-pulse"} ${className}`}
      // The SVG comes from the qrcode package, built from our own URL.
      dangerouslySetInnerHTML={{ __html: svg ?? "" }}
    />
  );
}

const noSubscribe = () => () => {};

/** The session link, known only in the browser (the host differs between local, preview and production). */
function useSessionUrl(sessionId: string, locale: string) {
  const origin = useSyncExternalStore(
    noSubscribe,
    () => location.origin,
    () => null,
  );
  if (!origin) return null;
  return { link: `${origin}/${locale}/s/${sessionId}`, site: `${new URL(origin).host}/${locale}/j` };
}

/** The empty session on a desktop: the QR code is there without a click. */
export function PhoneCard({
  presence,
  sessionId,
  code,
  locale,
  t,
}: {
  presence: Presence;
  sessionId: string;
  code: string;
  locale: "en" | "fr";
  t: Dictionary["devices"];
}) {
  const url = useSessionUrl(sessionId, locale);
  return (
    <div className="flex w-full max-w-64 flex-col items-center gap-3 rounded-3xl bg-surface p-5 text-center ring-1 ring-hairline">
      <p className="font-display text-lg font-semibold tracking-tight">{t.scanTitle}</p>
      {url ? (
        <SessionQr url={url.link} label={t.qrLabel} className="w-44" />
      ) : (
        <div className="aspect-square w-44 animate-pulse rounded-2xl bg-glass" />
      )}
      <p className="flex items-center gap-2 text-sm" aria-live="polite">
        {presence.phones > 0 ? (
          <>
            <span className="size-2 rounded-full bg-pousse" aria-hidden="true" />
            {presence.phones === 1 ? t.phoneOne : fill(t.phones, { n: presence.phones })}
          </>
        ) : (
          <span className="text-ink-soft">{t.scanLead}</span>
        )}
      </p>
      {url && <p className="text-xs text-ink-soft">{fill(t.orCode, { code, site: url.site })}</p>}
    </div>
  );
}

/** Desktop: who is connected, and a QR code to bring a phone in. Phone: which session this is. */
export function PresenceBar({
  presence,
  sessionId,
  code,
  locale,
  t,
}: {
  presence: Presence;
  sessionId: string;
  code: string;
  locale: "en" | "fr";
  t: Dictionary["devices"];
}) {
  const [open, setOpen] = useState(false);
  const url = useSessionUrl(sessionId, locale);
  const phone = presence.me?.kind === "phone";

  const dot = (on: boolean) => <span className={`size-2 rounded-full ${on ? "bg-pousse" : "bg-ink-soft/40"}`} aria-hidden="true" />;

  if (phone) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-soft" aria-live="polite">
        {dot(presence.desktops > 0)}
        {presence.desktops > 0 ? t.withDesktop : fill(t.sessionCode, { code })}
      </p>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass"
      >
        {dot(presence.phones > 0)}
        <span aria-live="polite">
          {presence.phones === 0 ? t.connect : presence.phones === 1 ? t.phoneOne : fill(t.phones, { n: presence.phones })}
        </span>
      </button>
      {open && url && (
        <div className="absolute right-0 z-20 mt-2 flex w-64 flex-col gap-3 rounded-3xl bg-surface p-4 shadow-2xl ring-1 ring-hairline">
          <SessionQr url={url.link} label={t.qrLabel} />
          <p className="text-sm text-ink-soft">{fill(t.orCode, { code, site: url.site })}</p>
          <button type="button" onClick={() => setOpen(false)} className="self-end text-sm font-medium underline-offset-4 hover:underline">
            {t.close}
          </button>
        </div>
      )}
    </div>
  );
}
