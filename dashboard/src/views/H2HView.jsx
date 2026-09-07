import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { formatCDMX } from '../lib/format'

export const H2HView = ({ format }) => {
  const players = useApi(`/api/stats/players?format=${format}`)

  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  // Solo se dispara al presionar "Comparar" (no en cada cambio de selección):
  // comparePath se queda en null hasta el click.
  const [comparePath, setComparePath] = useState(null)
  const h2h = useApi(comparePath)

  const compare = () => {
    setComparePath(`/api/stats/h2h?p1=${encodeURIComponent(p1)}&p2=${encodeURIComponent(p2)}&format=${format}`)
  }

  const data = h2h.data
  const winrate = data && data.duo.total > 0 ? Math.round((data.duo.wins / data.duo.total) * 100) : null
  const playerList = players.data || []

  return (
    <>
      <div className="secbar"><h2>Head to Head</h2><span className="note">Como rivales y como dupla</span></div>
      <div className="h2h-pickers">
        <select className="select-steel" value={p1} onChange={e => setP1(e.target.value)} aria-label="Jugador 1">
          <option value="">Jugador 1...</option>
          {playerList.map(p => <option key={p.gamertag} value={p.gamertag}>{p.gamertag}</option>)}
        </select>
        <span className="vs">VS</span>
        <select className="select-steel" value={p2} onChange={e => setP2(e.target.value)} aria-label="Jugador 2">
          <option value="">Jugador 2...</option>
          {playerList.map(p => <option key={p.gamertag} value={p.gamertag}>{p.gamertag}</option>)}
        </select>
        <button className="btn-steel" disabled={!p1 || !p2 || p1 === p2 || h2h.loading} onClick={compare}>
          {h2h.loading ? 'Comparando...' : 'Comparar'}
        </button>
      </div>

      {players.loading && <Skeleton variant="lines" rows={2} />}
      {players.error && <ErrorState message="No se pudo cargar la lista de jugadores." reload={players.reload} />}
      {!players.loading && !players.error && playerList.length === 0 && (
        <EmptyState>Se necesitan jugadores registrados para comparar.</EmptyState>
      )}

      {h2h.error && <ErrorState message="No se pudo comparar. Intenta de nuevo." reload={h2h.reload} />}

      {data && (
        <>
          <div className="h2h-grid">
            <div className="h2h-card">
              <div className="hc-title">⚔️ Como rivales</div>
              <div className="hc-big">{data.rivals.p1Wins} – {data.rivals.p2Wins}</div>
              <div className="hc-sub">
                <b>{data.p1}</b> vs <b>{data.p2}</b> · {data.rivals.total} partida{data.rivals.total !== 1 ? 's' : ''}
                {data.rivals.draws > 0 && ` · ${data.rivals.draws} empate${data.rivals.draws !== 1 ? 's' : ''}`}
              </div>
            </div>
            <div className="h2h-card">
              <div className="hc-title">🤝 Como dupla</div>
              <div className="hc-big">{data.duo.wins}V – {data.duo.losses}D{data.duo.draws > 0 ? ` – ${data.duo.draws}E` : ''}</div>
              <div className="hc-sub">
                {data.duo.total} partida{data.duo.total !== 1 ? 's' : ''} juntos
                {winrate !== null && <> · <b>{winrate}%</b> de victorias</>}
              </div>
            </div>
          </div>
          {data.shared.length === 0 ? (
            <EmptyState>Estos jugadores aún no comparten partidas.</EmptyState>
          ) : (
            <>
              <div className="secbar"><h2>Partidas compartidas</h2></div>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Mapa</th><th>Fecha</th><th className="c">Formato</th>
                      <th className="c">{data.p1}</th><th className="c">{data.p2}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.shared.map(m => {
                      const { dateStr, timeStr } = formatCDMX(m.timestamp)
                      const cell = p => (
                        <>
                          <span className={`res-${(p.result || 'd').toLowerCase()}`}>{p.result || '—'}</span>
                          {' '}{p.kills}/{p.deaths}/{p.assists}
                        </>
                      )
                      return (
                        <tr key={m.game_unique_id}>
                          <td className="player-name">{m.map_name}</td>
                          <td>{dateStr} {timeStr}</td>
                          <td className="c">{m.same_team ? '🤝 Dupla' : '⚔️ Rivales'}</td>
                          <td className="c">{cell(m.p1)}</td>
                          <td className="c">{cell(m.p2)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
