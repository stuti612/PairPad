import type { ConnectionStatus } from '../lib/useConnection'

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
}

function describe(status: ConnectionStatus, unsynced: boolean): string {
  switch (status) {
    case 'connected':
      return 'Your changes are syncing live.'
    case 'connecting':
      return 'Connecting to the pad.'
    case 'reconnecting':
    case 'offline': {
      const lead =
        status === 'offline' ? 'No connection.' : 'Connection lost. Trying to reconnect.'
      return unsynced
        ? `${lead} Your changes are kept in this tab and will merge when you are back online. Keep the tab open until then.`
        : `${lead} You can keep editing; changes will merge when you are back online.`
    }
  }
}

export function StatusBadge({ status, unsynced }: { status: ConnectionStatus; unsynced: boolean }) {
  return (
    <span
      className={`status status-${status}`}
      role="status"
      title={describe(status, unsynced)}
      data-status={status}
    >
      <span className="status-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  )
}
