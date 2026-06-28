import { redirect } from 'next/navigation'

export default function MobileRedirectPage() {
  redirect('/auth/mobile')
}
