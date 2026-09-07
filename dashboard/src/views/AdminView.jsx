import { useCallback, useEffect, useRef, useState } from 'react'
import { adminFetch, adminGetBlob, ApiError } from '../api/client'
import { useAdminApi } from '../hooks/useAdminApi'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { formatCDMX } from '../lib/format'

const ADMIN_KEY_STORAGE = 'cr:adminKey'

function readStoredKey() {
  try { return sessionStorage.getItem(ADMIN_KEY_STORAGE) || '' } catch { return '' }
}
function storeKey(key) {
  try {
    if (key) sessionStorage.setItem(ADMIN_KEY_STORAGE, key)
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE)
  } catch { /* sessionStorage no disponible (modo privado, etc.) */ }
}

const WhatsappSection = ({ adminKey, onUnauthorized }) => {
  const status = useAdminApi('/api/admin/whatsapp/status', adminKey, { onUnauthorized })
  const [qrUrl, setQrUrl] = useState(null)
  const [qrState, setQrState] = useState('loading') // loading | ready | empty | error
  const [qrTick, setQrTick] = useState(0)
  const qrUrlRef = useRef(null)

  // El fetch en sí NO llama setState de forma síncrona (todo pasa dentro de
  // los callbacks then/catch): así el efecto de abajo no dispara el aviso de
  // "setState síncrono en un efecto" de react-hooks. El botón "Actualizar"
  // sí puede poner 'loading' de una vez porque corre en un event handler.
  const fetchQr = useCallback(() => {
    return adminGetBlob('/api/admin/whatsapp/qr', { adminKey })
      .then(blob => {
        if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current)
        qrUrlRef.current = blob ? URL.createObjectURL(blob) : null
        setQrUrl(qrUrlRef.current)
        setQrState(blob ? 'ready' : 'empty')
      })
      .catch(err => {
        if (err instanceof ApiError && err.status === 401) onUnauthorized()
        setQrState('error')
      })
  }, [adminKey, onUnauthorized])

  useEffect(() => { fetchQr() }, [fetchQr, qrTick])
  // Libera el último object URL al desmontar la sección.
  useEffect(() => () => { if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current) }, [])

  const refreshQr = () => {
    setQrState('loading')
    setQrTick(t => t + 1)
  }

  return (
    <div className="admin-section">
      <h3>WhatsApp</h3>
      {status.loading && <Skeleton variant="lines" rows={2} />}
      {status.error && <ErrorState message="No se pudo leer el estado de WhatsApp." reload={status.reload} />}
      {status.data && (
        <div className="admin-kv">
          <div><span className="dim">Estado</span><b>{status.data.status}</b></div>
          <div><span className="dim">Grupo 2v2</span><b>{status.data.groups?.['2v2'] || '—'}</b></div>
          <div><span className="dim">Grupo 4v4</span><b>{status.data.groups?.['4v4'] || '—'}</b></div>
        </div>
      )}
      <div className="admin-qr">
        {qrState === 'loading' && <Skeleton variant="cards" rows={1} />}
        {qrState === 'empty' && <p className="dim">Sin QR pendiente (ya emparejado o servicio apagado).</p>}
        {qrState === 'error' && <ErrorState message="No se pudo cargar el QR." reload={refreshQr} />}
        {qrState === 'ready' && qrUrl && <img src={qrUrl} alt="QR de emparejamiento de WhatsApp" className="qr-img" />}
        <button className="btn-steel" onClick={refreshQr}>Actualizar QR</button>
      </div>
    </div>
  )
}

const GamesSection = ({ adminKey, onUnauthorized }) => {
  const games = useAdminApi('/api/admin/games?limit=20', adminKey, { onUnauthorized })
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState(null)

  const toggleVoid = async (game) => {
    const action = game.is_voided ? 'unvoid' : 'void'
    const label = game.is_voided ? 'restaurar' : 'anular'
    if (!window.confirm(`¿Seguro que quieres ${label} la partida de ${game.map_name}?`)) return

    setBusyId(game.game_unique_id)
    setActionError(null)
    try {
      await adminFetch(`/api/admin/games/${game.game_unique_id}/${action}`, { adminKey, method: 'POST' })
      games.reload()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized()
      else setActionError(`No se pudo ${label} la partida.`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="admin-section">
      <h3>Últimas partidas</h3>
      {games.loading && <Skeleton variant="table" rows={5} />}
      {games.error && <ErrorState message="No se pudieron cargar las partidas." reload={games.reload} />}
      {actionError && <p className="error-note">{actionError}</p>}
      {games.data && games.data.length === 0 && <p className="dim">Sin partidas.</p>}
      {games.data && games.data.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Mapa</th><th>Fecha</th><th className="c">Formato</th><th>Jugadores</th><th className="c">Estado</th><th></th></tr>
            </thead>
            <tbody>
              {games.data.map(g => {
                const { dateStr, timeStr } = formatCDMX(g.timestamp)
                return (
                  <tr key={g.game_unique_id}>
                    <td className="player-name">{g.map_name}</td>
                    <td>{dateStr} {timeStr}</td>
                    <td className="c">{g.format}</td>
                    <td>{(g.players || []).map(p => p.gamertag).join(', ')}</td>
                    <td className="c">
                      {g.is_voided ? <span className="res-l">Anulada</span> : <span className="res-w">Válida</span>}
                    </td>
                    <td className="c">
                      <button className="btn-steel small" disabled={busyId === g.game_unique_id}
                              onClick={() => toggleVoid(g)}>
                        {g.is_voided ? 'Restaurar' : 'Anular'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const RosterSection = ({ adminKey, onUnauthorized }) => {
  const roster = useAdminApi('/api/admin/whatsapp/roster', adminKey, { onUnauthorized })
  const links = roster.data?.links || []

  return (
    <div className="admin-section">
      <h3>Roster (solo lectura)</h3>
      <p className="dim">Vincular o desvincular gamertags se hace desde WhatsApp (!vincula, !roster unlink); esta tabla es solo de consulta.</p>
      {roster.loading && <Skeleton variant="lines" rows={3} />}
      {roster.error && <ErrorState message="No se pudo cargar el roster." reload={roster.reload} />}
      {roster.data && links.length === 0 && <p className="dim">Roster vacío.</p>}
      {links.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Gamertag</th><th className="c">Conocido</th><th>Vinculado por</th></tr></thead>
            <tbody>
              {links.map(l => (
                <tr key={l.gamertag}>
                  <td className="player-name">{l.gamertag}</td>
                  <td className="c">{l.known ? 'Sí' : 'No'}</td>
                  <td className="dim">{l.linkedBy || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export const AdminView = () => {
  const [adminKey, setAdminKey] = useState(readStoredKey)
  const [keyInput, setKeyInput] = useState('')
  const [authError, setAuthError] = useState(null)

  const onUnauthorized = useCallback(() => {
    storeKey('')
    setAdminKey('')
    setAuthError('Clave admin inválida o vencida.')
  }, [])

  const submit = (e) => {
    e.preventDefault()
    const key = keyInput.trim()
    if (!key) return
    setAuthError(null)
    storeKey(key)
    setAdminKey(key)
    setKeyInput('')
  }

  const logout = () => {
    storeKey('')
    setAdminKey('')
  }

  if (!adminKey) {
    return (
      <>
        <div className="secbar"><h2>Admin</h2></div>
        <form className="admin-login" onSubmit={submit}>
          <label htmlFor="admin-key">Clave de administrador</label>
          <input id="admin-key" type="password" className="input-steel" autoComplete="off"
                 value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="X-Admin-Key" />
          <button className="btn-steel" type="submit">Entrar</button>
          {authError && <p className="error-note">{authError}</p>}
        </form>
      </>
    )
  }

  return (
    <>
      <div className="secbar">
        <h2>Admin</h2>
        <button className="link-note" onClick={logout}>Salir</button>
      </div>
      <WhatsappSection adminKey={adminKey} onUnauthorized={onUnauthorized} />
      <GamesSection adminKey={adminKey} onUnauthorized={onUnauthorized} />
      <RosterSection adminKey={adminKey} onUnauthorized={onUnauthorized} />
    </>
  )
}
