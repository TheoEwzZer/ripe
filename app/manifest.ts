import type { MetadataRoute } from "next";

/** Installable from the browser: the phone keeps Ripe on its home screen, full screen in the kitchen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ripe — Cook what's ripe",
    short_name: "Ripe",
    description: "Snap your fridge. Ripe outlines every ingredient, reads how fresh it is and cooks what needs eating first.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#1c121f",
    theme_color: "#1c121f",
    categories: ["food", "lifestyle"],
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/brand/ripe-app-icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
