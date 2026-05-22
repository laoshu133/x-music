import type { Metadata } from 'next'
import Script from 'next/script'
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

const isProduction = process.env.NODE_ENV === 'production'

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {isProduction ? (
          <Script
            id="LA_COLLECT"
            src="//sdk.51.la/js-sdk-pro.min.js?id=LCW93BU74YqqESL1&ck=LCW93BU74YqqESL1"
            charSet="UTF-8"
            strategy="afterInteractive"
          />
        ) : null}
      </body>
    </html>
  )
}
