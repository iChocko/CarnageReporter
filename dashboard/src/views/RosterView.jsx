import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'

export const RosterView = ({ format, navigate }) => {
  const roster = useApi(`/api/stats/roster?format=${format}`)
  const list = roster.data || []

  return (
    <>
      <div className="secbar">
        <h2>Roster</h2>
        <span className="note">Gamertag registrado en el bot de WhatsApp</span>
      </div>

      {roster.loading ? <Skeleton variant="lines" rows={4} /> : roster.error ? (
        <ErrorState message="No se pudo cargar el roster." reload={roster.reload} />
      ) : list.length === 0 ? <EmptyState>Todavía no hay nadie registrado.</EmptyState> : (
        <div className="player-chips">
          {list.map(p => (
            <button
              key={p.gamertag}
              className={`pchip roster-chip ${p.known ? 'known' : 'unknown'}`}
              onClick={() => navigate(`/perfil/${encodeURIComponent(p.gamertag)}`)}
              title={p.known ? `${p.totalGames} partida${p.totalGames !== 1 ? 's' : ''}` : 'Sin partidas todavía'}
            >
              {p.gamertag}
              <span className="roster-tag">{p.known ? 'conocido' : 'desconocido'}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
