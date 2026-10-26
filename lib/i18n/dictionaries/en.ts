export const en = {
  meta: {
    title: "Ripe — Cook what's ripe",
    description:
      "Snap your fridge. Ripe outlines every ingredient, reads how fresh it is and cooks what needs eating first.",
  },
  nav: {
    language: "Language",
    switchTo: "Français",
  },
  home: {
    tagline: "Cook what's ripe.",
    lead: "Snap your fridge. Ripe outlines every ingredient, reads how fresh it is and cooks what needs eating first.",
    start: "Start a session",
    starting: "Opening…",
    lab: "Open the lab",
    backendDown: "Realtime backend unreachable. Run npm run dev to start Convex.",
  },
  session: {
    code: "Session code",
    status: "Status",
    expired: "This session has expired or does not exist.",
  },
  lab: {
    title: "Pipeline lab",
    lead: "Day 1 bench: a recorded fridge photo goes through the same parser and freshness rules as the live API.",
    source: "Source",
    sourceMock: "Synthetic recording (no API key, $0)",
    sourceLive: "Recorded from the Meta Model API",
    items: "ingredients",
    daysLeft: "D-{n}",
    today: "Today",
    confidence: "confidence",
    noRecording: "No recording yet. Run npm run fixtures:mock to create one.",
    priority: "Cook first",
  },
  freshness: {
    betterave: "Today",
    kaki: "1–2 days",
    safran: "3–5 days",
    pousse: "Fresh",
  },
} as const;

export type Dictionary = {
  [K in keyof typeof en]: { [P in keyof (typeof en)[K]]: string };
};
