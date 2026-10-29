"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

/** The fallback when the QR code won't scan: the 4-character code shown on the computer. */
export function JoinForm({ locale, t }: { locale: "en" | "fr"; t: Dictionary["devices"] }) {
  const find = useMutation(api.sessions.findByCode);
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setMissing(false);
        try {
          const sessionId = await find({ code });
          if (sessionId) {
            router.push(`/${locale}/s/${sessionId}`);
            return;
          }
          setMissing(true);
        } catch {
          setMissing(true);
        }
        setPending(false);
      }}
    >
      <label className="flex flex-col gap-2">
        <span className="text-sm text-ink-soft">{t.joinField}</span>
        <input
          value={code}
          onChange={(e) =>
            setCode(
              e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 4),
            )
          }
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="rounded-2xl bg-surface px-4 py-3 text-center font-mono text-3xl tracking-[0.4em] uppercase ring-1 ring-hairline outline-none focus:ring-2 focus:ring-kaki"
        />
      </label>
      {missing && (
        <p className="text-sm text-betterave" role="alert">
          {t.joinNotFound}
        </p>
      )}
      <button
        type="submit"
        disabled={code.length !== 4 || pending}
        className="rounded-full bg-aubergine px-6 py-3 font-medium text-porcelaine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 dark:bg-porcelaine dark:text-aubergine"
      >
        {pending ? t.joining : t.join}
      </button>
    </form>
  );
}
