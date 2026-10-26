"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n/config";

export function LangToggle({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname();
  const target: Locale = locale === "en" ? "fr" : "en";
  const href = pathname.replace(/^\/(en|fr)(?=\/|$)/, `/${target}`);

  return (
    <Link
      href={href}
      hrefLang={target}
      lang={target}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE}=${target}; path=/; max-age=31536000; samesite=lax`;
      }}
      className="rounded-full px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-glass hover:text-ink"
    >
      {label}
    </Link>
  );
}
