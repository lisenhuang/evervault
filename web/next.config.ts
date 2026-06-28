import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker prod image.
  output: "standalone",
  // pnpm symlinks deps into .pnpm and there is a stray pnpm-workspace.yaml in web/.
  // Pin file tracing to THIS dir so the standalone bundle only traces web/'s deps and
  // does not walk up to the repo root (which holds app/ and backend/).
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
