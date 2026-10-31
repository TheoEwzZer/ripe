"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** VAPID keys travel as URL-safe base64; the push manager wants the raw bytes. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

type State = { kind: "idle" } | { kind: "busy" } | { kind: "on"; next: number | null } | { kind: "error"; message: string };

/** "Remind me": a notification on the evening before each urgent item's last good day. */
export function RemindMe({ sessionId, locale, t }: { sessionId: Id<"sessions">; locale: "en" | "fr"; t: Dictionary["reminders"] }) {
  const publicKey = useQuery(api.reminders.publicKey);
  const subscribe = useMutation(api.reminders.subscribe);
  const test = useMutation(api.reminders.test);
  const [state, setState] = useState<State>({ kind: "idle" });

  if (!publicKey) return null;

  const enable = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState({ kind: "error", message: t.unsupported });
      return;
    }
    setState({ kind: "busy" });
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setState({ kind: "error", message: t.denied });
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      const { next } = await subscribe({
        sessionId,
        locale,
        tzOffset: new Date().getTimezoneOffset(),
        subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
      });
      setState({ kind: "on", next });
    } catch {
      setState({ kind: "error", message: t.failed });
    }
  };

  const when = (at: number) =>
    new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" }).format(at);

  return (
    <div className="flex flex-col gap-1.5">
      {state.kind === "on" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
          <span>{state.next ? fill(t.enabled, { when: when(state.next) }) : t.enabledNone}</span>
          <button type="button" onClick={() => void test({ sessionId, locale })} className="font-medium underline-offset-4 hover:underline">
            {t.test}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void enable()}
          disabled={state.kind === "busy"}
          className="rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-60"
        >
          🔔 {state.kind === "busy" ? t.enabling : t.enable}
        </button>
      )}
      {state.kind === "error" && <p className="text-xs text-betterave">{state.message}</p>}
    </div>
  );
}
