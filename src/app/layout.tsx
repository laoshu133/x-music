import type { Metadata } from 'next'
import './styles.css'

export const metadata: Metadata = {
  title: 'XMusic',
  description: 'Private music player with QQ Music metadata and local cache.',
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/public/logo.png',
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
