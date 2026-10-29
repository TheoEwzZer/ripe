import Link from "next/link";
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { Suspense } from "react";
import { Logo } from "@/components/brand/Logo";
import { CookSignal } from "@/components/cook/CookSignal";
import { LangToggle } from "@/components/LangToggle";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";

/** The session shell; `modal` holds a recipe opened from the workspace (an intercepted r/[recipeId]). */
export default async function SessionLayout({ children, modal }: LayoutProps<"/[lang]/s/[id]">) {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  const t = await getDictionary(locale);

  return (
    <>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
        <header className="flex items-center justify-between">
          <Link href={`/${locale}`} aria-label="Ripe">
            <Logo className="h-8 w-auto text-ink" />
          </Link>
          <Suspense>
            <LangToggle locale={locale} label={t.nav.switchTo} />
          </Suspense>
        </header>
        {children}
      </main>
      {modal}
      <Suspense>
        <CookSignal />
      </Suspense>
    </>
  );
}
