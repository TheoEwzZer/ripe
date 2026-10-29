"use client";

import { useQuery } from "convex/react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { api } from "@/convex/_generated/api";
import { deviceKind } from "@/lib/client/device";

/** On a phone, a recipe sent from the desktop opens cooking mode, wherever the phone is in the session. */
export function CookSignal() {
  const { id, lang } = useParams<{ id: string; lang: string }>();
  const session = useQuery(api.sessions.get, { sessionId: id });
  const router = useRouter();
  const pathname = usePathname();
  // The first value is history: only a send that happens while this screen is open counts.
  const seen = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (session === undefined) return;
    const at = session?.cooking?.at ?? null;
    if (seen.current === undefined) {
      seen.current = at;
      return;
    }
    if (at === null || at === seen.current) return;
    seen.current = at;
    const target = `/${lang}/s/${id}/cook/${session?.cooking?.recipeId}`;
    if (deviceKind() === "phone" && pathname !== target) router.push(target);
  }, [session, lang, id, pathname, router]);

  return null;
}
