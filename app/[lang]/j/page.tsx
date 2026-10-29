import Link from "next/link";
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Logo } from "@/components/brand/Logo";
import { JoinForm } from "@/components/session/JoinForm";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** ripe…/j: a phone joins the desktop's session by its code. */
export default async function JoinPage() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-10 px-4 py-6">
      <Link href={`/${locale}`} aria-label="Ripe">
        <Logo className="h-8 w-auto text-ink" />
      </Link>
      <section className="glass flex flex-col gap-5 rounded-3xl p-6">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-extrabold tracking-tight">{t.devices.joinTitle}</h1>
          <p className="text-ink-soft">{t.devices.joinLead}</p>
        </div>
        <JoinForm locale={locale} t={t.devices} />
      </section>
    </main>
  );
}
