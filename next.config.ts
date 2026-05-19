import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: ['172.16.3.9'],
  output: 'standalone',
}

export default nextConfig
