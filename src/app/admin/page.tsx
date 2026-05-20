import { Suspense } from 'react'
import MusicClient from '../client'

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <MusicClient />
    </Suspense>
  )
}
