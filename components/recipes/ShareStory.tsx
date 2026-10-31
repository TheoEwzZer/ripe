"use client";

import { useState } from "react";

/** Shares the story card as an image where the browser can (phones), downloads it elsewhere. */
export function ShareStory({
  sessionId,
  recipeId,
  title,
  labels,
}: {
  sessionId: string;
  recipeId: string;
  title: string;
  labels: { share: string; sharing: string; shareText: string };
}) {
  const [busy, setBusy] = useState(false);
  const share = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/story/${sessionId}/${recipeId}`);
      if (!response.ok) throw new Error(`Story card failed with ${response.status}`);
      const file = new File([await response.blob()], "ripe-story.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title, text: `${labels.shareText} · ${title}` });
      } else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
    } catch {
      // Cancelled share sheets land here too: nothing to report.
    }
    setBusy(false);
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      disabled={busy}
      className="rounded-full px-5 py-2.5 text-sm font-medium ring-1 ring-hairline transition-colors hover:bg-glass disabled:opacity-60"
    >
      {busy ? labels.sharing : labels.share}
    </button>
  );
}
