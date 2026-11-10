import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@prisma/client", "@prisma/adapter-pg"],
};

export default config;
