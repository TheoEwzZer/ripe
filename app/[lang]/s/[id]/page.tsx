import { lang } from "next/root-params";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Logo } from "@/components/brand/Logo";
import { SessionLive } from "@/components/session/SessionLive";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

export default async function SessionPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-6 sm:px-8">
      <Logo className="h-8 w-auto text-ink" />
      <Suspense fallback={<div className="h-40 rounded-3xl bg-glass" />}>
        <SessionLive labels={t.session} />
      </Suspense>
    </main>
  );
}
