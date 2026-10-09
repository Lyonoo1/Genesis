/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
      {
        source: "/db",
        destination: "http://localhost:8000/db",
      },
      {
        source: "/api/db/:path*",
        destination: "http://localhost:8000/api/db/:path*",
      },
    ];
  },
};

export default nextConfig;
