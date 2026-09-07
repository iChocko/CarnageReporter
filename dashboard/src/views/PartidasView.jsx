import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { MatchCard } from '../components/MatchCard'

export const PartidasView = ({ format }) => {
  const recent = useApi(`/api/stats/recent?format=${format}`)

  return (
    <>
      <div className="secbar">
        <h2>Historial de partidas</h2>
        <span className="note">Solo customs 2v2 válidas · hora CDMX</span>
      </div>
      {recent.loading ? <Skeleton variant="cards" rows={4} /> : recent.error ? (
        <ErrorState message="No se pudo cargar el historial de partidas." reload={recent.reload} />
      ) : recent.data.length === 0 ? <EmptyState /> : (
        <div className="match-list">
          {recent.data.map(g => <MatchCard key={g.game_unique_id} game={g} />)}
        </div>
      )}
    </>
  )
}
