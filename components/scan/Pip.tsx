import { pipFill, tierColorVar, tierFor } from "@/lib/pantry/freshness";

/** Freshness pip: colour plus a fill that drains, so the state reads without colour too. */
export function Pip({ daysLeft, className = "size-4" }: { daysLeft: number; className?: string }) {
  const fill = pipFill(daysLeft);
  const color = tierColorVar[tierFor(daysLeft)];
  const angle = 2 * Math.PI * fill;
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      {fill >= 1 ? (
        <circle cx="8" cy="8" r="5" fill={color} />
      ) : (
        <path fill={color} d={`M8 8V3A5 5 0 ${fill > 0.5 ? 1 : 0} 1 ${8 + 5 * Math.sin(angle)} ${8 - 5 * Math.cos(angle)}Z`} />
      )}
    </svg>
  );
}

export function dayLabel(daysLeft: number, labels: { daysLeft: string; today: string }) {
  return daysLeft <= 0 ? labels.today : labels.daysLeft.replace("{n}", String(daysLeft));
}
