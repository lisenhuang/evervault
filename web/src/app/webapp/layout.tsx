import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "EverVault — Chat",
  description: "Chat with AI by text or voice.",
  // iOS decides "open this like an app" from these rather than from the manifest on older versions,
  // and still reads the title for the home-screen label. The status bar stays "default" so iOS keeps
  // reserving its strip instead of letting the chat header slide underneath it.
  appleWebApp: {
    capable: true,
    title: "EverVault",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  // Paint the browser's own surfaces — the Android status bar, the installed window's title bar — to
  // match the app underneath, per colour scheme. The manifest carries a single fallback for the splash
  // screen; this is the one that can follow the theme the user is actually in.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function WebappLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col">{children}</div>;
}
