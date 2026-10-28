/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/genesis";

const nextConfig = {
  basePath,
  assetPrefix: basePath,
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      ...(basePath
        ? [
            {
              source: "/",
              destination: basePath,
              basePath: false,
              permanent: false,
            },
          ]
        : []),
    ];
  },
  async rewrites() {
    const internalApi = process.env.INTERNAL_API_URL || "http://localhost:8000";
    return [
      {
        source: "/db",
        destination: `${internalApi}/db`,
      },
      {
        source: "/api/db/:path*",
        destination: `${internalApi}/api/db/:path*`,
      },
    ];
  },
};

export default nextConfig;
