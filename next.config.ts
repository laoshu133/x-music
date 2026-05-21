import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: ['172.16.3.9'],
  output: 'standalone',
  async rewrites() {
    return {
      fallback: [
        {
          source: '/:path((?!api(?:/|$)|_next(?:/|$)|public(?:/|$)|favicon\\.ico$|admin(?:/|$)|x-music(?:/|$)).*)',
          destination: '/x-music/emby/:path*',
        },
      ],
    }
  },
}

export default nextConfig
