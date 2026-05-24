import type { Metadata } from 'next'
import './styles.css'

export const metadata: Metadata = {
  title: 'XMusic | 把 QQ 音乐装进自己口袋',
  description: '把 QQ 音乐收藏、歌单和播放记录带到自己的播放器。',
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/public/logo.png',
  },
}

const analyticsScriptCode = readAnalyticsScriptCode()

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {analyticsScriptCode ? <div dangerouslySetInnerHTML={{ __html: analyticsScriptCode }} /> : null}
      </body>
    </html>
  )
}

function readAnalyticsScriptCode(): string | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined
  return process.env.ANALYTICS_SCRIPT_CODE || undefined
}
