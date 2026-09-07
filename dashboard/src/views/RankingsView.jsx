import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { MatchCard } from '../components/MatchCard'
import { MatchHero } from '../components/MatchHero'
import { TierBadge } from '../components/TierBadge'
import { recordStr } from '../lib/format'

export const RankingsView = ({ format, navigate }) => {
  const leaderboard = useApi(`/api/stats/leaderboard?limit=50&format=${format}`)
  const recent = useApi(`/api/stats/recent?format=${format}`)

  const openProfile = (gamertag) => navigate(`/perfil/${encodeURIComponent(gamertag)}`)

  return (
    <div className="main-grid">
      <div>
        <div className="secbar">
          <h2>Slayer Rankings</h2>
          <span className="note formula-hint">
            <button aria-label="Cómo se calcula el tier">i</button>
            <span className="tip">
              El tier sale de un Slayer Score interno 0–100 (40% KDA + 30% eficiencia + 30% mejor racha).
              Jugadores con menos de 5 partidas aparecen como PLACEMENT.
            </span>
          </span>
        </div>
        {leaderboard.loading ? <Skeleton variant="table" rows={8} /> : leaderboard.error ? (
          <ErrorState message="No se pudo cargar la tabla de posiciones." reload={leaderboard.reload} />
        ) : leaderboard.data.length === 0 ? <EmptyState /> : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="c">#</th><th>Jugador</th><th className="c">KD</th>
                  <th className="c">KDA</th><th className="c">V-D</th><th className="c">Tier</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.data.map((p, i) => (
                  <tr key={p.gamertag} className="clickable" tabIndex={0}
                      onClick={() => openProfile(p.gamertag)}
                      onKeyDown={e => e.key === 'Enter' && openProfile(p.gamertag)}>
                    <td className="c rank-col">{p.is_placement ? '—' : i + 1}</td>
                    <td>
                      <span className="player-name" style={p.is_placement ? { color: 'var(--steel-dim)' } : undefined}>{p.gamertag}</span>
                      <br /><span className="games-sub">{p.total_games} partidas</span>
                    </td>
                    <td className="c">{p.overall_kd}</td>
                    <td className={`c ${p.kda >= 1 ? 'kd-pos' : 'kd-neg'}`}>{p.kda}</td>
                    <td className="c">{recordStr(p)}</td>
                    <td className="c"><TierBadge tier={p.tier} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="secbar gold">
          <h2>Última partida</h2>
        </div>
        {recent.loading ? <Skeleton variant="hero" /> : recent.error ? (
          <ErrorState message="No se pudieron cargar las partidas recientes." reload={recent.reload} />
        ) : recent.data.length === 0 ? <EmptyState /> : (
          <>
            <MatchHero game={recent.data[0]} />
            {recent.data.length > 1 && (
              <>
                <div className="secbar" style={{ marginTop: 20 }}>
                  <h2>Recientes</h2>
                  <button className="tab" style={{ border: '1px solid var(--line)', padding: '5px 12px', fontSize: 11 }} onClick={() => navigate('/partidas')}>
                    Ver todas
                  </button>
                </div>
                <div className="match-list">
                  {recent.data.slice(1, 4).map(g => <MatchCard key={g.game_unique_id} game={g} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
