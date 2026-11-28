import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["node:sqlite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/mcp", destination: "/api/mcp" },
      { source: "/mcp/:server", destination: "/api/mcp/:server" },
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth-server/metadata" },
      { source: "/.well-known/oauth-authorization-server/:rest*", destination: "/api/oauth-server/metadata" },
      { source: "/.well-known/openid-configuration", destination: "/api/oauth-server/metadata" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth-server/resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth-server/resource/:path*" },
      { source: "/oauth/register", destination: "/api/oauth-server/register" },
      { source: "/oauth/token", destination: "/api/oauth-server/token" },
      { source: "/oauth/revoke", destination: "/api/oauth-server/revoke" },
    ];
  },
};

export default nextConfig;
