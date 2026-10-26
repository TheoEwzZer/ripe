"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Locale } from "@/lib/i18n/config";

type Labels = { start: string; starting: string };

function ConnectedButton({ locale, labels }: { locale: Locale; labels: Labels }) {
  const create = useMutation(api.sessions.create);
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const { sessionId } = await create({ locale });
          router.push(`/${locale}/s/${sessionId}`);
        } catch {
          setPending(false);
        }
      }}
      className="rounded-full bg-aubergine px-6 py-3 font-medium text-porcelaine dark:bg-porcelaine dark:text-aubergine transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
    >
      {pending ? labels.starting : labels.start}
    </button>
  );
}

export function StartSessionButton({
  locale,
  labels,
  backendDown,
}: {
  locale: Locale;
  labels: Labels;
  backendDown: string;
}) {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) return <p className="text-sm text-ink-soft">{backendDown}</p>;
  return <ConnectedButton locale={locale} labels={labels} />;
}
