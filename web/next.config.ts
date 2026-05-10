import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg (node-postgres) uses native Node.js modules that can't be bundled
  // by webpack. Mark it as external so Next.js uses the installed package
  // directly at runtime instead of trying to bundle it.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
