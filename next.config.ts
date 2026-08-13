import type { NextConfig } from "next";

const isGitHubPagesBuild = process.env.GITHUB_PAGES_BUILD === "true";

const nextConfig: NextConfig = isGitHubPagesBuild
  ? {
      assetPrefix: "/taipei-usage-flow-dashboard",
      output: "export",
      trailingSlash: true,
    }
  : {};

export default nextConfig;
