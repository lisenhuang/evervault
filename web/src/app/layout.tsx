import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { getServerLang } from "@/i18n/server";
import { htmlLang } from "@/i18n/config";

// Runs during HTML parse, before first paint, to set the theme class and avoid a
// flash of the wrong theme. Stored "light"/"dark" wins; "system" (or nothing stored)
// follows the OS.
const themeScript = `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EverVault — Your personal memory AI",
  description:
    "A private place that quietly remembers your conversations, ideas, and moments, and helps you find them again whenever you need. Remember everything. Carry nothing.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewportFit: cover enables env(safe-area-inset-*) so the chat composer can clear
  // the home indicator. interactiveWidget: resizes-content makes the on-screen keyboard
  // shrink the layout viewport on Chrome, so dvh-based heights collapse and the composer
  // stays pinned above the keyboard.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve the display language server-side (cookie → Accept-Language) so server-rendered pages
  // come out in the right language with no flash. Seeds the client provider via `initialLang`.
  const lang = await getServerLang();
  return (
    <html
      lang={htmlLang(lang)}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <LanguageProvider initialLang={lang}>
          <ThemeProvider>{children}</ThemeProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
