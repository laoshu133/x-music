import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: ['172.16.3.9'],
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  output: 'standalone',
}

export default nextConfig
