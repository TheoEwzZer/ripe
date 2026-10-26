"use client";

import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type Labels = { code: string; status: string; expired: string };

/** Day 1 proof that the session lives in Convex and updates in real time. QR and capture land on day 3. */
export function SessionLive({ labels }: { labels: Labels }) {
  const { id } = useParams<{ id: string }>();
  const session = useQuery(api.sessions.get, { sessionId: id as Id<"sessions"> });

  if (session === undefined) return <div className="h-40 animate-pulse rounded-3xl bg-glass" aria-busy="true" />;
  if (session === null) return <p className="text-ink-soft">{labels.expired}</p>;

  return (
    <div className="glass rounded-3xl p-8">
      <p className="text-sm text-ink-soft">{labels.code}</p>
      <p className="font-mono text-6xl font-semibold tracking-[0.2em]">{session.code}</p>
      <p className="mt-4 text-sm text-ink-soft">
        {labels.status}: <span className="text-ink">{session.status}</span>
      </p>
    </div>
  );
}
