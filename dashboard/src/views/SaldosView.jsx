import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { formatCDMX } from '../lib/format'

export const SaldosView = ({ navigate }) => {
  const saldos = useApi('/api/stats/saldos')
  const data = saldos.data

  return (
    <>
      <div className="secbar">
        <h2>Saldos</h2>
        <span className="note">
          <button className="link-note" onClick={() => navigate('/roster')}>Ver roster</button>
        </span>
      </div>

      {saldos.loading ? <Skeleton variant="table" rows={4} /> : saldos.error ? (
        <ErrorState message="No se pudo cargar los saldos." reload={saldos.reload} />
      ) : !data || data.gamesCount === 0 ? <EmptyState>Semana a mano: nadie debe nada.</EmptyState> : (
        <>
          <div className="rondas-meta">
            <span className="dim">
              {data.sinceTs ? `Desde ${formatCDMX(data.sinceTs).dateStr} ${formatCDMX(data.sinceTs).timeStr}` : 'Desde el inicio'}
            </span>
            <span className="dim">{data.gamesCount} partida{data.gamesCount !== 1 ? 's' : ''}</span>
          </div>

          {data.saldos.length === 0 ? (
            <EmptyState>Semana a mano: nadie debe nada.</EmptyState>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Deben</th><th>A</th><th className="c">Rondas</th><th className="c">Monto</th></tr>
                </thead>
                <tbody>
                  {data.saldos.map((s, i) => (
                    <tr key={i}>
                      <td className="player-name">{s.losers.join(' + ')}</td>
                      <td className="player-name">{s.winners.join(' + ')}</td>
                      <td className="c">{s.rounds}</td>
                      <td className="c">${s.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}
