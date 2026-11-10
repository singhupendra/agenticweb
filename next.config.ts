import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone", // self-contained server bundle for the production Docker image (see Dockerfile)
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@prisma/client", "@prisma/adapter-pg"],
};

export default config;
