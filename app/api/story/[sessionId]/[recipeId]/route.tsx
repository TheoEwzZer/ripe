import { ConvexHttpClient } from "convex/browser";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { formatters } from "@/components/impact/format";
import { api } from "@/convex/_generated/api";
import { getDictionary } from "@/lib/i18n/get-dictionary";

const W = 1080;
const H = 1920;
const INK = "#f4f7f3";
const NIGHT = "#2a1630";

const loaded = new Map<string, Promise<ArrayBuffer | null>>();

/** A Google font as TrueType (Satori reads no WOFF2); null if it cannot load, and the card falls back to the default face. */
function googleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  const key = `${family}:${weight}`;
  if (!loaded.has(key))
    loaded.set(
      key,
      (async () => {
        try {
          // An old user agent makes Google Fonts answer with a TrueType file.
          const css = await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
          }).then((r) => r.text());
          const url = /src: url\((.+?)\) format\(.(truetype|opentype).\)/.exec(css)?.[1];
          return url ? await fetch(url).then((r) => r.arrayBuffer()) : null;
        } catch {
          return null;
        }
      })(),
    );
  return loaded.get(key)!;
}

/** Satori draws PNG and JPEG only: plates are WebP, so every picture goes through sharp first. */
async function squareJpeg(src: string, base: string): Promise<string | null> {
  try {
    const response = await fetch(new URL(src, base));
    if (!response.ok) return null;
    const jpeg = await sharp(Buffer.from(await response.arrayBuffer()))
      .resize(960, 960, { fit: "cover" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

/** A story-format card (1080×1920) for one recipe: the dish, what it saved, no model involved. */
export async function GET(request: Request, ctx: RouteContext<"/api/story/[sessionId]/[recipeId]">) {
  const { sessionId, recipeId } = await ctx.params;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return new Response("Not configured", { status: 503 });
  const data = await new ConvexHttpClient(convexUrl).query(api.recipes.story, { sessionId, recipeId });
  if (!data) return new Response("Not found", { status: 404 });
  const t = (await getDictionary(data.locale)).story;
  const f = formatters(data.locale);
  const image = data.image ? await squareJpeg(data.image, request.url) : null;
  const host = new URL(request.url).host;
  // Funnel Display signs the titles, Figtree carries the rest, as in the app.
  const [display, body] = await Promise.all([googleFont("Funnel Display", 800), googleFont("Figtree", 500)]);
  const title = display ? { fontFamily: "Funnel Display" } : {};
  const fonts = [
    ...(body ? [{ name: "Figtree", data: body, weight: 500 as const, style: "normal" as const }] : []),
    ...(display ? [{ name: "Funnel Display", data: display, weight: 800 as const, style: "normal" as const }] : []),
  ];

  return new ImageResponse(
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        background: NIGHT,
        color: INK,
        padding: 60,
        gap: 40,
        fontFamily: body ? "Figtree" : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ ...title, fontSize: 72, letterSpacing: -2 }}>ripe</span>
        <span style={{ fontSize: 30, opacity: 0.7 }}>{t.tagline}</span>
      </div>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} width={960} height={960} style={{ borderRadius: 48, objectFit: "cover" }} alt="" />
      ) : (
        <div style={{ width: 960, height: 960, borderRadius: 48, background: "#160d18" }} />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <span style={{ ...title, fontSize: 66, lineHeight: 1.05, letterSpacing: -1.5 }}>{data.title}</span>
        <span style={{ fontSize: 32, opacity: 0.7 }}>
          {t.minutes.replace("{n}", String(data.minutes))} · {t.score.replace("{n}", String(data.score))}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: "auto" }}>
        <span style={{ fontSize: 32, color: "#46b162", fontWeight: 700 }}>{t.saved}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {data.items.slice(0, 8).map((name) => (
            <span key={name} style={{ fontSize: 30, padding: "8px 22px", borderRadius: 999, border: "2px solid rgba(244,247,243,0.35)" }}>
              {name}
            </span>
          ))}
        </div>
        <div style={{ ...title, display: "flex", gap: 40, fontSize: 46 }}>
          <span>{f.kg(data.impact.kg)}</span>
          <span>{f.eur(data.impact.eur)}</span>
          <span>{f.co2e(data.impact.co2e).replace("₂", "2")}</span>
        </div>
        <span style={{ fontSize: 26, opacity: 0.55 }}>{t.footer.replace("{site}", host)}</span>
      </div>
    </div>,
    {
      width: W,
      height: H,
      fonts: fonts.length ? fonts : undefined,
      headers: { "Cache-Control": "private, max-age=60" },
    },
  );
}
