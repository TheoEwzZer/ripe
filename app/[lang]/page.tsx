import Link from "next/link";
import { notFound } from "next/navigation";
import { LangToggle } from "@/components/LangToggle";
import { Logo } from "@/components/brand/Logo";
import { StartSessionButton } from "@/components/StartSessionButton";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const t = await getDictionary(lang);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Logo className="h-9 w-auto text-ink" />
        <LangToggle locale={lang} label={t.nav.switchTo} />
      </header>

      <section className="flex flex-1 flex-col justify-center gap-6 py-16">
        <h1 className="font-display text-5xl font-extrabold leading-[1.02] tracking-tight wrap-break-word sm:text-7xl">
          {t.home.tagline}
        </h1>
        <p className="max-w-xl text-lg text-ink-soft">{t.home.lead}</p>
        <div className="flex flex-wrap items-center gap-3">
          <StartSessionButton
            locale={lang}
            labels={{ start: t.home.start, starting: t.home.starting }}
            backendDown={t.home.backendDown}
          />
          <Link
            href={`/${lang}/lab`}
            className="rounded-full px-5 py-3 font-medium text-ink underline-offset-4 transition-colors hover:underline"
          >
            {t.home.lab}
          </Link>
        </div>
      </section>
    </main>
  );
}
