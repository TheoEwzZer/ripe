"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * The recipe sheet over the session: a side panel on desktop so the photo,
 * with the recipe's ingredients lit, stays in view; full screen on a phone.
 * Closing goes back, so the browser's back button closes it too.
 */
export function RecipeModal({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = () => router.back();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    document.addEventListener("keydown", onKey);
    // Locking <html>, not <body>: a hidden body becomes the photo's scroll container and unsticks it.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      root.style.overflow = overflow;
    };
  }, [router]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 bg-nuit/30" onClick={close} aria-hidden="true" />
      <div
        ref={panel}
        tabIndex={-1}
        className="relative h-full w-full overflow-y-auto overscroll-contain bg-surface shadow-2xl outline-none sm:max-w-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children(close)}
      </div>
    </div>
  );
}
