/** @type {import('next').NextConfig} */
const isDesktop = process.env.DESKTOP_BUILD === "true";
const basePath = isDesktop ? "" : (process.env.NEXT_PUBLIC_BASE_PATH || "/genesis");

const nextConfig = {
  output: isDesktop ? "export" : undefined,
  distDir: isDesktop ? "out" : ".next",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  env: isDesktop
    ? {
        NEXT_PUBLIC_BASE_PATH: "",
        NEXT_PUBLIC_API_BASE_URL: "",
      }
    : undefined,
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  ...(isDesktop
    ? {}
    : {
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
      }),
};

export default nextConfig;
