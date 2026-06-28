<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Rules

- **After finishing any code change, make sure the build succeeds.** Run `pnpm build`
  (from `web/`) and confirm it completes without errors. If it fails, read the error
  output and fix the code until the build passes — do not leave the change in a
  broken state.
