import { lazy, Suspense } from 'react'
import { isValidRoomId } from './lib/rooms'
import { Landing } from './pages/Landing'
import { NotFound } from './pages/NotFound'
import { usePathname } from './router'

// The editor is most of the bundle, so the landing page loads without it.
const Pad = lazy(() => import('./pages/Pad').then((module) => ({ default: module.Pad })))

const PAD_ROUTE = /^\/pad\/([^/]+)\/?$/

export function App() {
  const pathname = usePathname()

  if (pathname === '/') return <Landing />

  const roomId = PAD_ROUTE.exec(pathname)?.[1]
  if (roomId && isValidRoomId(roomId)) {
    return (
      <Suspense fallback={<div className="pad" />}>
        {/* Keyed so switching pads tears down the old document and connection. */}
        <Pad key={roomId} roomId={roomId} />
      </Suspense>
    )
  }
  return <NotFound />
}
