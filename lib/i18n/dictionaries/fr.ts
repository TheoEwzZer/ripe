import type { Dictionary } from "./en";

export const fr: Dictionary = {
  meta: {
    title: "Ripe — Cuisine ce qui presse",
    description:
      "Photographie ton frigo. Ripe détoure chaque aliment, estime sa fraîcheur et cuisine d'abord ce qui presse.",
  },
  nav: {
    language: "Langue",
    switchTo: "English",
  },
  home: {
    tagline: "Cuisine ce qui presse.",
    lead: "Photographie ton frigo. Ripe détoure chaque aliment, estime sa fraîcheur et cuisine d'abord ce qui presse.",
    start: "Lancer une session",
    starting: "Ouverture…",
    lab: "Ouvrir le labo",
    backendDown: "Backend temps réel injoignable. Lance npm run dev pour démarrer Convex.",
  },
  session: {
    code: "Code de session",
    status: "État",
    expired: "Cette session a expiré ou n'existe pas.",
  },
  lab: {
    title: "Labo du pipeline",
    lead: "Banc d'essai du jour 1 : une photo de frigo enregistrée passe par le même parseur et les mêmes règles de fraîcheur que l'API réelle.",
    source: "Source",
    sourceMock: "Enregistrement synthétique (sans clé API, 0 €)",
    sourceLive: "Enregistré depuis le Meta Model API",
    items: "aliments",
    daysLeft: "J-{n}",
    today: "Aujourd'hui",
    confidence: "confiance",
    noRecording: "Aucun enregistrement. Lance npm run fixtures:mock pour en créer un.",
    priority: "À cuisiner d'abord",
  },
  freshness: {
    betterave: "Aujourd'hui",
    kaki: "1 à 2 jours",
    safran: "3 à 5 jours",
    pousse: "Frais",
  },
};
