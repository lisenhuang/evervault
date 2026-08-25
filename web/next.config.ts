import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker prod image.
  output: "standalone",
  // pnpm symlinks deps into .pnpm and there is a stray pnpm-workspace.yaml in web/.
  // Pin file tracing to THIS dir so the standalone bundle only traces web/'s deps and
  // does not walk up to the repo root (which holds app/ and backend/).
  outputFileTracingRoot: path.join(__dirname),
  // /ppt is the name people type when they are looking for a slide deck; /deck is what it is
  // called. Keep both working so a link written either way lands in the same place.
  async redirects() {
    return [{ source: "/ppt", destination: "/deck", permanent: false }];
  },
};

export default nextConfig;
