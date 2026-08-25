import { NextResponse } from "next/server";
import type { MetadataRoute } from "next";

/**
 * The web app manifest — what lets someone install /webapp from their browser and open it from the
 * home screen like any other app, with no browser chrome around it.
 *
 * Scoped to /webapp rather than the whole site on purpose. The site root is a marketing page; the app
 * is the thing worth installing. Scope is also what keeps the installed window feeling like an app
 * instead of a browser: a link inside the scope stays in the window, and one outside it (the landing
 * page, an external link the assistant sends) opens in the real browser where the address bar and the
 * user's usual controls are.
 *
 * A ROUTE HANDLER, NOT app/manifest.ts. The file convention would be the obvious way to write this,
 * and this was that until the install prompt started turning up on the landing page, the deck and the
 * admin panel. The convention links the manifest from every page in the app and offers no way to
 * narrow that — `manifest: null` in a layout does not override it, and the docs put the file at the
 * app root by definition. A plain route handler serves the identical bytes at the identical URL
 * without the link, leaving webapp/layout.tsx to link it for the one route the scope covers. Keeping
 * the URL matters beyond tidiness: it is where already-installed apps re-fetch their manifest from.
 *
 * No service worker, deliberately. Installability needs a manifest and HTTPS, and nothing else — the
 * Next.js guide for this version says so outright. A service worker would only earn its keep for
 * offline use, which an assistant that cannot answer without the network doesn't have, and it would
 * bring a real hazard with it: a worker that outlives a deploy can keep serving the previous release
 * to users who have already "updated", on a site where pushing to main IS the deploy.
 */
const manifest: MetadataRoute.Manifest = {
  id: "/webapp",
  name: "EverVault",
  short_name: "EverVault",
  description: "Chat with AI by text or voice.",
  start_url: "/webapp",
  scope: "/webapp",
  display: "standalone",
  // If a browser can't do standalone, prefer the one that keeps a back button over falling all the
  // way back to a normal tab.
  display_override: ["standalone", "minimal-ui"],
  orientation: "portrait-primary",
  // The colour of the splash screen an installed app shows while it starts. Light, because it has to
  // be one value and there is no way to vary it by colour scheme — unlike the theme colour, which is
  // set per scheme on the page itself (see the webapp layout).
  background_color: "#ffffff",
  theme_color: "#ffffff",
  // The same square serves both purposes: it is a centred mark on a full-bleed white ground, so it
  // survives being masked into whatever shape a launcher uses without the glyph reaching the crop.
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// Nothing here reads the request, so it prerenders to a static file exactly as the file convention
// did. The content type is the one the spec asks for, and the one the convention emitted.
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
