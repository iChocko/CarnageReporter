import { usePagedApi } from '../hooks/usePagedApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { MatchCard } from '../components/MatchCard'
import { formatCDMX, formatDayCDMX, groupSessions } from '../lib/format'

const PAGE_SIZE = 50

const NOTE = {
  '2v2': 'Solo customs 2v2 válidas · hora CDMX',
  '4v4': 'Customs y matchmaking 4v4 válidas · hora CDMX',
}

export const PartidasView = ({ format }) => {
  const history = usePagedApi(`/api/stats/recent?format=${format}`, PAGE_SIZE)
  const sessions = groupSessions(history.items)

  return (
    <>
      <div className="secbar">
        <h2>Historial de partidas</h2>
        <span className="note">{NOTE[format] || NOTE['2v2']}</span>
      </div>
      {history.initialLoading ? <Skeleton variant="cards" rows={4} /> : history.items.length === 0 ? (
        history.error
          ? <ErrorState message="No se pudo cargar el historial de partidas." reload={history.retry} />
          : <EmptyState>Aún no hay partidas {format} registradas.</EmptyState>
      ) : (
        <>
          {sessions.map((s, i) => {
            // La última reta cargada puede seguir en la página siguiente: no se sabe aún su inicio ni el total
            const partial = history.hasMore && i === sessions.length - 1
            return (
              <section className="reta" key={s.key} aria-label={`Reta del ${formatDayCDMX(s.startTs)}`}>
                <div className="reta-head">
                  <span className="reta-day">{formatDayCDMX(s.startTs)}</span>
                  <span className="reta-meta">
                    {partial ? '…' : formatCDMX(s.startTs).timeStr} – {formatCDMX(s.endTs).timeStr} · {s.games.length}{partial ? '+' : ''} {s.games.length === 1 && !partial ? 'partida' : 'partidas'}
                  </span>
                </div>
                <div className="match-list">
                  {s.games.map(g => <MatchCard key={g.game_unique_id} game={g} />)}
                </div>
              </section>
            )
          })}
          {history.error ? (
            <ErrorState message="No se pudieron cargar más partidas." reload={history.retry} />
          ) : history.hasMore && (
            <div className="load-more">
              <button className="btn-steel" onClick={history.loadMore} disabled={history.loading}>
                {history.loading ? 'Cargando…' : 'Cargar más partidas'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
