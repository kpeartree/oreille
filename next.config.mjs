/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  headers: async () => [
    {
      source: '/models/:path*',
      headers: [
        { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
      ],
    },
  ],
}

export default nextConfig
