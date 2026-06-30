import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "EverVault — Chat",
  description: "Chat with AI by text or voice.",
};

export default function WebappLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col">{children}</div>;
}
