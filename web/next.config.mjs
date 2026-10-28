/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
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
