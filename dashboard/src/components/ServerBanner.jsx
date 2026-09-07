import { useEffect, useState } from 'react'

const POLL_MS = 60000

async function checkHealth() {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return false
    const body = await res.json().catch(() => null)
    return body?.status !== 'down'
  } catch {
    return false
  }
}

/** Aviso persistente cuando /api/health falla o reporta status "down". */
export const ServerBanner = () => {
  const [healthy, setHealthy] = useState(true)

  useEffect(() => {
    let cancelled = false
    const poll = () => { checkHealth().then(ok => { if (!cancelled) setHealthy(ok) }) }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (healthy) return null

  return (
    <div className="server-banner" role="alert">
      ⚠️ Servidor no disponible — los datos pueden estar desactualizados
    </div>
  )
}
