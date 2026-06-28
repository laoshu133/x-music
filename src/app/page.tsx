import { Suspense } from 'react'
import MusicClient from './client'
import { getInitialAccount } from './initial-account'

export default async function HomePage() {
  const initialAccount = await getInitialAccount()

  return (
    <Suspense fallback={null}>
      <MusicClient initialAccount={initialAccount} />
    </Suspense>
  )
}
