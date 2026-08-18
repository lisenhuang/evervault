# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## Rules

- **Stay in the Expo Managed Workflow. Do NOT eject to bare / generate native code.**
  Do not run `expo prebuild`, `expo eject`, or otherwise create or commit the native
  `android/` and `ios/` directories. Add native capabilities through Expo config
  plugins and `app.json`/`app.config.js` (Continuous Native Generation), and build
  via EAS Build — never by hand-editing native projects.

- **Every screen must be designed for both phone and tablet — on iOS *and* Android.**
  Four form factors are in scope for every layout: iPhone, iPad, Android phone, Android
  tablet (plus foldables, which change size while running). A screen that only looks
  right on a phone is not done.
  - **Branch on width, never on device type.** Use `useWindowDimensions()` and a
    breakpoint (`width >= 768` for the tablet layout). Do *not* branch on
    `expo-device`'s `DeviceType` or `Platform.isPad`: iPad Split View / Slide Over and
    Android split-screen hand the app a phone-width window at runtime, and dimensions
    update live while a device check does not.
  - **Tablets get a real tablet layout, not a stretched phone.** Above the breakpoint,
    use the extra width — sidebar/detail split, multi-column lists, wider content with a
    `maxWidth` so text lines don't run edge to edge. Below it, the same screens collapse
    into a pushed stack. Apple rejects iPad builds that are visibly upscaled phone UI.
  - **Required config.** `ios.supportsTablet: true` in `app.json`, or the app runs
    letterboxed in iPhone compatibility mode on iPad. Android tablets need no flag, but
    a locked `orientation` gets the app letterboxed on Android 12L+ large screens and
    fights how people hold a tablet — keep `orientation` unlocked (`"default"`) and lock
    per-screen with `expo-screen-orientation` only where a screen genuinely requires it.
  - **No hardcoded sizes.** Use flex, percentages, and `react-native-safe-area-context`
    insets — never fixed pixel widths or hand-tuned padding for a notch. Safe-area insets
    differ sharply between notched phones and tablets.
