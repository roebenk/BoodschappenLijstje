import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
  output: "standalone",
  serverExternalPackages: ["picnic-api"],
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
});

export default nextConfig;
