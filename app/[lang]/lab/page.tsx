import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { LangToggle } from "@/components/LangToggle";
import { LabReplay } from "@/components/lab/LabReplay";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import type { Recording } from "@/lib/replay/recording";

/** Prefers a live recording (made with npm run probe) over the synthetic one. Cached: restart dev after a new probe. */
async function loadRecording(): Promise<Recording | null> {
  "use cache";
  const dir = path.join(process.cwd(), "fixtures", "recordings");
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  const pick = files.find((f) => f.includes(".live.")) ?? files[0];
  if (!pick) return null;
  return JSON.parse(await readFile(path.join(dir, pick), "utf8")) as Recording;
}

export default async function LabPage({ params }: PageProps<"/[lang]/lab">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const t = await getDictionary(lang);
  const recording = await loadRecording();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Link href={`/${lang}`} aria-label="Ripe">
          <Logo className="h-8 w-auto text-ink" />
        </Link>
        <LangToggle locale={lang} label={t.nav.switchTo} />
      </header>

      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-extrabold tracking-tight wrap-break-word">{t.lab.title}</h1>
        <p className="max-w-2xl text-ink-soft">{t.lab.lead}</p>
        {recording && (
          <p className="text-sm text-ink-soft">
            {t.lab.source}: {recording.source === "live" ? t.lab.sourceLive : t.lab.sourceMock}
            {recording.source === "live" && <span className="font-mono"> (${recording.totalCostUsd.toFixed(3)})</span>}
          </p>
        )}
      </div>

      {recording ? (
        <LabReplay recording={recording} t={{ scan: t.scan, replay: t.lab.replay }} />
      ) : (
        <p className="text-ink-soft">{t.lab.noRecording}</p>
      )}
    </main>
  );
}
