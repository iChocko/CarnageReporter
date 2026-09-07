import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { formatCDMX } from '../lib/format'

export const PerfilView = ({ format, gamertag, navigate }) => {
  const players = useApi(`/api/stats/players?format=${format}`)
  const profile = useApi(gamertag ? `/api/stats/player/${encodeURIComponent(gamertag)}?format=${format}` : null)

  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const playerList = players.data || []
    const q = query.trim().toLowerCase()
    return q ? playerList.filter(p => p.gamertag.toLowerCase().includes(q)) : playerList
  }, [players.data, query])

  const selectPlayer = (tag) => navigate(`/perfil/${encodeURIComponent(tag)}`)

  // Coincidencia única en el buscador -> navegar directo a ese perfil.
  // navigate() sincroniza la URL (sistema externo), no estado local, así
  // que llamarlo desde el efecto no dispara el warning set-state-in-effect.
  useEffect(() => {
    if (query.trim() && filtered.length === 1 && filtered[0].gamertag !== gamertag) {
      navigate(`/perfil/${encodeURIComponent(filtered[0].gamertag)}`)
    }
  }, [query, filtered, gamertag, navigate])

  return (
    <>
      <div className="secbar"><h2>Perfil de jugador</h2><span className="note">Busca por gamertag</span></div>
      <div className="player-picker">
        <input type="search" className="input-steel" placeholder="Buscar gamertag..."
               aria-label="Buscar jugador por gamertag" autoComplete="off"
               value={query} onChange={e => setQuery(e.target.value)} />
        <div className="player-chips">
          {filtered.map(p => (
            <button key={p.gamertag} className={`pchip ${p.gamertag === gamertag ? 'active' : ''}`}
                    onClick={() => selectPlayer(p.gamertag)}>
              {p.gamertag}
            </button>
          ))}
        </div>
      </div>

      {players.loading && <Skeleton variant="lines" rows={3} />}
      {players.error && <ErrorState message="No se pudo cargar la lista de jugadores." reload={players.reload} />}
      {!players.loading && !players.error && (players.data || []).length === 0 && <EmptyState />}

      {gamertag && profile.loading && <Skeleton variant="cards" rows={1} />}
      {profile.error && <ErrorState message={`No se encontró el perfil de "${gamertag}".`} reload={profile.reload} />}

      {profile.data && !profile.loading && (
        <>
          <div className="profile-head">
            <div className="pname">{profile.data.gamertag}</div>
          </div>
          <div className="pstats">
            <div className="pstat"><b>{profile.data.games}</b><span>Partidas</span></div>
            <div className="pstat"><b>{profile.data.wins}</b><span>Victorias</span></div>
            <div className="pstat"><b>{profile.data.losses}</b><span>Derrotas</span></div>
            {profile.data.draws > 0 && <div className="pstat"><b>{profile.data.draws}</b><span>Empates</span></div>}
            <div className="pstat"><b>{profile.data.kills}</b><span>Bajas</span></div>
            <div className="pstat"><b>{profile.data.kd.toFixed(2)}</b><span>K/D</span></div>
            <div className="pstat"><b>{profile.data.kda.toFixed(2)}</b><span>KDA</span></div>
            <div className="pstat"><b>{profile.data.bestSpree}</b><span>Mejor racha</span></div>
          </div>
          <div className="secbar"><h2>Historial</h2></div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Mapa</th><th>Fecha</th><th className="c">Resultado</th><th className="c">B / M / A</th><th className="c">K/D</th></tr>
              </thead>
              <tbody>
                {profile.data.history.map(h => {
                  const { dateStr, timeStr } = formatCDMX(h.timestamp)
                  const resTxt = h.result === 'W' ? 'Victoria' : h.result === 'L' ? 'Derrota' : 'Empate'
                  return (
                    <tr key={h.game_unique_id}>
                      <td className="player-name">{h.map_name}</td>
                      <td>{dateStr} {timeStr}</td>
                      <td className={`c res-${(h.result || 'd').toLowerCase()}`}>{resTxt}</td>
                      <td className="c">{h.kills} / {h.deaths} / {h.assists}</td>
                      <td className={`c ${h.kd >= 1 ? 'kd-pos' : 'kd-neg'}`}>{h.kd.toFixed(2)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
