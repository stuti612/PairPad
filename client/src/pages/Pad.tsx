import { useEffect } from 'react'
import { Editor } from '../components/Editor'
import { TopBar } from '../components/TopBar'
import { usePad, useSharedLanguage, type PadSession } from '../lib/usePad'

export function Pad({ roomId }: { roomId: string }) {
  const session = usePad(roomId)

  useEffect(() => {
    document.title = `${roomId} · PairPad`
    return () => {
      document.title = 'PairPad'
    }
  }, [roomId])

  if (!session) return <div className="pad" />
  return <PadView roomId={roomId} session={session} />
}

function PadView({ roomId, session }: { roomId: string; session: PadSession }) {
  const [language, setLanguage] = useSharedLanguage(session.meta)

  return (
    <div className="pad">
      <TopBar roomId={roomId} language={language} onLanguageChange={setLanguage} />
      <Editor text={session.text} language={language} />
    </div>
  )
}
