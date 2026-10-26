import { useId } from "react";

const PEAR =
  "M30.88 20.72C34.24 20.72 35.92 23.52 36.48 26.88C37.04 30.24 43.2 33.04 43.2 42C43.2 48.16 38.16 52.08 32 52.08C25.84 52.08 20.8 48.16 20.8 42C20.8 33.6 25.84 30.24 25.84 26.88C25.84 23.52 27.52 20.72 30.88 20.72Z";

function Symbol({ gradientId }: { gradientId: string }) {
  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="20.7" x2="0" y2="52.1" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7CC35B" />
          <stop offset=".5" stopColor="var(--color-safran)" />
          <stop offset="1" stopColor="var(--color-kaki)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round">
        <path d="M6 19V12a6 6 0 0 1 6-6h7" />
        <path d="M45 6h7a6 6 0 0 1 6 6v7" />
        <path d="M58 45v7a6 6 0 0 1-6 6h-7" />
        <path d="M19 58h-7a6 6 0 0 1-6-6v-7" />
      </g>
      <path fill={`url(#${gradientId})`} d={PEAR} />
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M30.99 20.94C31.22 18.93 31.89 17.36 33.01 16.02" />
      <path fill="var(--color-feuille)" d="M32.56 17.81C34.13 13.33 38.16 11.31 42.86 12.21C41.3 16.69 37.26 18.7 32.56 17.81Z" />
    </>
  );
}

/** Pear in viewfinder brackets plus the monoline "ripe" wordmark. Ink follows currentColor. */
export function Logo({ className, title = "Ripe" }: { className?: string; title?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 185 64" role="img" aria-label={title} className={className}>
      <Symbol gradientId={gradientId} />
      <g transform="translate(77 3.3) scale(1.1)">
        <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 36.5V27c0-6 4-9.5 10-9.5" />
          <path d="M26.5 17.5v19" />
          <path d="M41 17.5V50" />
          <path d="M41 27a10 10 0 1 1 20 0a10 10 0 1 1-20 0" />
          <path d="M74 27h20a10 10 0 1 0-5.31 8.83" />
        </g>
        <path fill="var(--color-feuille)" d="M22 9.5C22 3.5 26 0 32.5 0c0 6-4 9.5-10.5 9.5Z" />
      </g>
    </svg>
  );
}

export function LogoSymbol({ className, title = "Ripe" }: { className?: string; title?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={title} className={className}>
      <Symbol gradientId={gradientId} />
    </svg>
  );
}
