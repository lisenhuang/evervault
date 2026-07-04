// App colour palette (light + dark), extending the starter tokens with the accents the chat UI needs.
// One source of truth; components read it via useColors().

import { useColorScheme } from "@/hooks/use-color-scheme";

export type AppColors = {
  text: string;
  textSecondary: string;
  textMuted: string;
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  accent: string;
  accentText: string;
  bubbleUser: string;
  bubbleUserText: string;
  bubbleAssistant: string;
  bubbleAssistantText: string;
  danger: string;
  success: string;
  callBg: string;
  onCall: string;
};

export const Palette: { light: AppColors; dark: AppColors } = {
  light: {
    text: "#0A0A0F",
    textSecondary: "#5B5F66",
    textMuted: "#8A8F98",
    background: "#FFFFFF",
    surface: "#F5F6F8",
    surfaceAlt: "#EDEEF1",
    border: "#E3E4E8",
    accent: "#2563EB",
    accentText: "#FFFFFF",
    bubbleUser: "#2563EB",
    bubbleUserText: "#FFFFFF",
    bubbleAssistant: "#F0F1F4",
    bubbleAssistantText: "#0A0A0F",
    danger: "#DC2626",
    success: "#16A34A",
    callBg: "#0A0A0F",
    onCall: "#FFFFFF",
  },
  dark: {
    text: "#F5F6F8",
    textSecondary: "#A8ADB5",
    textMuted: "#6B7280",
    background: "#0A0A0F",
    surface: "#16171C",
    surfaceAlt: "#1E2026",
    border: "#2A2C33",
    accent: "#3B82F6",
    accentText: "#FFFFFF",
    bubbleUser: "#2563EB",
    bubbleUserText: "#FFFFFF",
    bubbleAssistant: "#1E2026",
    bubbleAssistantText: "#F5F6F8",
    danger: "#F87171",
    success: "#4ADE80",
    callBg: "#05050A",
    onCall: "#FFFFFF",
  },
};

export function useColors(): AppColors {
  const scheme = useColorScheme();
  return scheme === "dark" ? Palette.dark : Palette.light;
}
