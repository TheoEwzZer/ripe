const KEY = "ripe.device";

/** This browser's device id; storage can be blocked, so it falls back to one per page load. */
export function deviceKey(): string {
  try {
    const known = localStorage.getItem(KEY);
    if (known) return known;
    const fresh = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID().replace(/-/g, "");
  }
}

/** A touch screen narrower than a laptop is a phone: it captures and cooks. */
export function deviceKind(): "desktop" | "phone" {
  return matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820 ? "phone" : "desktop";
}

const HOUSEHOLD = "ripe.household";

/** The household this device belongs to: an anonymous id, never tied to a person. */
export function householdKey(): string | null {
  try {
    const known = localStorage.getItem(HOUSEHOLD);
    if (known) return known;
    const fresh = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(HOUSEHOLD, fresh);
    return fresh;
  } catch {
    return null;
  }
}
