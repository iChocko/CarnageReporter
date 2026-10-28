import { useState } from 'react'
import { adminFetch, ApiError } from '../api/client'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { formatCDMX } from '../lib/format'

const ESTADOS_VISIBLES = ['revisar', 'anulada', 'cuenta', 'empate', 'reiniciada', 'excluida', 'cancelada']
const TIPO_LABEL = { excluir: 'Excluir', fijar: 'Fijar', resultado: 'Resultado manual', wo: 'W.O.', cancelar: 'Cancelar serie' }

/**
 * Panel del torneo dentro de /admin. Funciona con ADMIN_KEY o con la clave
 * individual de cada organizador (torneo_accesos): todo pega a /api/admin/torneo/*.
 * `api` = useAdminApi('/api/admin/torneo') (AdminView ya lo trae para
 * saber el rol; aquí se reutiliza).
 */
export const TorneoAdminSection = ({ api, adminKey, onUnauthorized }) => {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [filtro, setFiltro] = useState('pendientes')
  const [fijar, setFijar] = useState(null) // { gameId, serie, slot }
  const [manual, setManual] = useState({ tipo: 'resultado', serie: '1', slot: '1', ganador: '', nota: '' })
  const [jsonText, setJsonText] = useState(null)

  const config = api.data?.config
  const result = api.data?.result

  const call = async (path, opts, okText) => {
    setBusy(true)
    setMsg(null)
    try {
      await adminFetch(path, { adminKey, ...opts })
      setMsg({ ok: true, text: okText })
      api.reload()
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized()
      setMsg({ ok: false, text: err.body?.error || 'No se pudo guardar.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const addOverride = (body, okText) => call('/api/admin/torneo/overrides', { method: 'POST', body }, okText)

  if (api.loading) return <div className="admin-section"><h3>Torneo</h3><Skeleton variant="table" rows={4} /></div>
  if (api.error) return <div className="admin-section"><h3>Torneo</h3><ErrorState message="No se pudo cargar el torneo." reload={api.reload} /></div>

  const saveJson = async () => {
    let body
    try { body = JSON.parse(jsonText) } catch { setMsg({ ok: false, text: 'El JSON no es válido.' }); return }
    if (await call('/api/admin/torneo', { method: 'PUT', body }, 'Config guardada.')) setJsonText(null)
  }

  const series = result?.series || []
  const equipos = result?.torneo?.equipos || []
  const teamName = id => equipos.find(e => e.id === id)?.nombre || id
  const serieSel = series.find(s => String(s.n) === String(manual.serie))
  const candidatas = (result?.candidatas || [])
    .filter(c => ESTADOS_VISIBLES.includes(c.estado))
    .filter(c => filtro === 'todas' || ['revisar', 'anulada'].includes(c.estado))
    .slice().reverse()
  const noRegistrados = [...new Map((result?.candidatas || []).flatMap(c => c.noRegistrados)
    .map(u => [u.gamertag.toLowerCase(), u])).values()]

  return (
    <div className="admin-section">
      <h3>Torneo {result ? `· ${result.torneo.nombre}` : ''}</h3>
      {msg && <p className={`ta-msg ${msg.ok ? 'res-w' : 'error-note'}`}>{msg.text}</p>}

      {!config && <p className="dim">No hay torneo configurado. Pega la config en el editor de abajo.</p>}

      {result && (
        <>
          <h4 className="dim">Partidas del torneo</h4>
          <div className="ta-grid">
            <button className={`pchip ${filtro === 'pendientes' ? 'active' : ''}`} onClick={() => setFiltro('pendientes')}>Por revisar</button>
            <button className={`pchip ${filtro === 'todas' ? 'active' : ''}`} onClick={() => setFiltro('todas')}>Todas</button>
          </div>
          {candidatas.length === 0 ? <p className="dim">Nada por revisar. ✅</p> : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Partida</th><th>Equipos</th><th className="c">Serie</th><th>Estado</th><th></th></tr>
                </thead>
                <tbody>
                  {candidatas.map(c => {
                    const { dateStr, timeStr } = formatCDMX(c.timestamp)
                    const excl = (config?.overrides || []).find(o => o.tipo === 'excluir' && o.gameId === c.gameId)
                    const fij = (config?.overrides || []).find(o => o.tipo === 'fijar' && o.gameId === c.gameId)
                    return (
                      <tr key={c.gameId}>
                        <td>{dateStr} {timeStr}<div className="dim">{c.gameId.slice(0, 8)}</div></td>
                        <td className="wrap-sm">{c.mapa} · {c.gameType}{c.terminoAntes && <div className="dc-tag">sin llegar al objetivo</div>}</td>
                        <td className="wrap-sm">{c.lados.map(l => `${teamName(l.equipo)} ${l.puntos}`).join(' vs ')}</td>
                        <td className="c">{c.serie ? `${c.serie}${c.slot ? ` · G${c.slot}` : ''}` : '—'}</td>
                        <td className="wrap-sm"><span className={`ta-estado-${c.estado}`}>{c.estado}</span>{c.motivo && <div className="dim">{c.motivo}</div>}</td>
                        <td className="c">
                          {excl ? (
                            <button className="btn-steel small" disabled={busy}
                                    onClick={() => call(`/api/admin/torneo/overrides/${excl.id}`, { method: 'DELETE' }, 'Exclusión quitada.')}>Incluir</button>
                          ) : (
                            <button className="btn-steel small" disabled={busy}
                                    onClick={() => addOverride({ tipo: 'excluir', gameId: c.gameId }, 'Partida excluida.')}>Excluir</button>
                          )}
                          {fij ? (
                            <button className="btn-steel small" disabled={busy}
                                    onClick={() => call(`/api/admin/torneo/overrides/${fij.id}`, { method: 'DELETE' }, 'Ya no está fijada.')}>Desfijar</button>
                          ) : (
                            <button className="btn-steel small" disabled={busy}
                                    onClick={() => setFijar({ gameId: c.gameId, serie: String(c.serie || 1), slot: String(c.slot || 1) })}>Fijar…</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {fijar && (
            <div className="ta-grid">
              <span>Fijar {fijar.gameId.slice(0, 8)} a</span>
              <select className="select-steel" value={fijar.serie} onChange={e => setFijar({ ...fijar, serie: e.target.value })}>
                {series.map(s => <option key={s.n} value={s.n}>Serie {s.n}: {teamName(s.a)} vs {teamName(s.b)}</option>)}
              </select>
              <select className="select-steel" value={fijar.slot} onChange={e => setFijar({ ...fijar, slot: e.target.value })}>
                {(series.find(s => String(s.n) === fijar.serie)?.games || []).map(g => (
                  <option key={g.slot} value={g.slot}>G{g.slot} · {g.mapa} {g.modo}</option>
                ))}
              </select>
              <button className="btn-steel small" disabled={busy}
                      onClick={async () => {
                        if (await addOverride({ tipo: 'fijar', gameId: fijar.gameId, serie: Number(fijar.serie), slot: Number(fijar.slot) }, 'Partida fijada.')) setFijar(null)
                      }}>Guardar</button>
              <button className="link-note" onClick={() => setFijar(null)}>Cancelar</button>
            </div>
          )}

          <h4 className="dim">Resultado manual, W.O. o cancelar serie</h4>
          <div className="ta-grid">
            <select className="select-steel" value={manual.tipo} onChange={e => setManual({ ...manual, tipo: e.target.value })}>
              <option value="resultado">Resultado manual de un game</option>
              <option value="wo">W.O. de la serie</option>
              <option value="cancelar">Cancelar la serie</option>
            </select>
            <select className="select-steel" value={manual.serie} onChange={e => setManual({ ...manual, serie: e.target.value, ganador: '' })}>
              {series.map(s => <option key={s.n} value={s.n}>Serie {s.n}: {teamName(s.a)} vs {teamName(s.b)}</option>)}
            </select>
            {manual.tipo === 'resultado' && (
              <select className="select-steel" value={manual.slot} onChange={e => setManual({ ...manual, slot: e.target.value })}>
                {(serieSel?.games || []).map(g => <option key={g.slot} value={g.slot}>G{g.slot} · {g.mapa}</option>)}
              </select>
            )}
            {manual.tipo !== 'cancelar' && serieSel && (
              <select className="select-steel" value={manual.ganador} onChange={e => setManual({ ...manual, ganador: e.target.value })}>
                <option value="">Ganador…</option>
                <option value={serieSel.a}>{teamName(serieSel.a)}</option>
                <option value={serieSel.b}>{teamName(serieSel.b)}</option>
              </select>
            )}
            <input className="input-steel" placeholder="Nota (opcional)" value={manual.nota}
                   onChange={e => setManual({ ...manual, nota: e.target.value })} />
            <button className="btn-steel small" disabled={busy || (manual.tipo !== 'cancelar' && !manual.ganador)}
                    onClick={() => addOverride({
                      tipo: manual.tipo, serie: Number(manual.serie), slot: Number(manual.slot),
                      ganador: manual.ganador || undefined, nota: manual.nota || undefined,
                    }, `${TIPO_LABEL[manual.tipo]} guardado.`)}>Guardar</button>
          </div>

          {noRegistrados.length > 0 && (
            <>
              <h4 className="dim">Gamertags no registrados</h4>
              {noRegistrados.map(u => (
                <AsignarGamertag key={u.gamertag} u={u} equipo={equipos.find(e => e.id === u.equipo)} busy={busy}
                                 onAssign={(jugador) => call('/api/admin/torneo/gamertags', {
                                   method: 'POST', body: { equipo: u.equipo, jugador, gamertag: u.gamertag },
                                 }, `${u.gamertag} asignado a ${jugador}.`)} />
              ))}
            </>
          )}

          <h4 className="dim">Correcciones guardadas</h4>
          {(config?.overrides || []).length === 0 ? <p className="dim">Ninguna.</p> : (
            <div className="tablewrap">
              <table>
                <thead><tr><th>Tipo</th><th>Detalle</th><th>Por</th><th></th></tr></thead>
                <tbody>
                  {config.overrides.slice().reverse().map(o => (
                    <tr key={o.id}>
                      <td>{TIPO_LABEL[o.tipo] || o.tipo}</td>
                      <td className="wrap-sm">
                        {o.gameId && `${o.gameId.slice(0, 8)} `}
                        {o.serie && `serie ${o.serie}`}{o.slot && ` · G${o.slot}`}{o.ganador && ` · gana ${teamName(o.ganador)}`}
                        {o.nota && <div className="dim">{o.nota}</div>}
                      </td>
                      <td className="dim">{o.por}{o.at && <div>{formatCDMX(o.at).dateStr} {formatCDMX(o.at).timeStr}</div>}</td>
                      <td className="c">
                        <button className="btn-steel small" disabled={busy}
                                onClick={() => call(`/api/admin/torneo/overrides/${o.id}`, { method: 'DELETE' }, 'Corrección deshecha.')}>Deshacer</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h4 className="dim">Config (JSON)</h4>
      {jsonText === null ? (
        <button className="btn-steel small" onClick={() => setJsonText(JSON.stringify(config || {}, null, 2))}>Editar config</button>
      ) : (
        <>
          <textarea className="input-steel ta-json" value={jsonText} onChange={e => setJsonText(e.target.value)} spellCheck={false} />
          <div className="ta-grid">
            <button className="btn-steel small" disabled={busy} onClick={saveJson}>Guardar config</button>
            <button className="link-note" onClick={() => setJsonText(null)}>Cancelar</button>
          </div>
        </>
      )}
    </div>
  )
}

const AsignarGamertag = ({ u, equipo, busy, onAssign }) => {
  const [jugador, setJugador] = useState('')
  return (
    <div className="ta-grid">
      <span><b>{u.gamertag}</b> <span className="dim">jugó con {equipo?.nombre || u.equipo}</span></span>
      <select className="select-steel" value={jugador} onChange={e => setJugador(e.target.value)}>
        <option value="">Es cuenta de…</option>
        {(equipo?.jugadores || []).map(j => <option key={j.nombre} value={j.nombre}>{j.nombre}</option>)}
      </select>
      <button className="btn-steel small" disabled={busy || !jugador} onClick={() => onAssign(jugador)}>Asignar</button>
    </div>
  )
}
