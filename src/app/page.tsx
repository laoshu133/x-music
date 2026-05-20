import { Suspense } from 'react'
import MusicClient from './client'

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <MusicClient />
    </Suspense>
  )
}
