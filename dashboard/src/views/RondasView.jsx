import { useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'

const KIND_LABEL = { wo: 'W.O.', ajuste: 'Ajuste' }

/** Puntitos Bo3: llenos = partidas ganadas por ese lado en la ronda. */
const BoDots = ({ wins }) => (
  <span className="bo-dots" aria-hidden="true">
    {[0, 1].map(i => <span key={i} className={`bo-dot ${i < wins ? 'filled' : ''}`} />)}
  </span>
)

const GameRow = ({ g }) => (
  <div className={`ronda-game ${g.winnerSide === 0 ? 'won-l' : g.winnerSide === 1 ? 'won-r' : 'tie'}`}>
    <span className="rg-map">{g.map}</span>
    {g.kind !== 'game' && <span className={`rg-kind rg-${g.kind}`}>{KIND_LABEL[g.kind]}</span>}
    <span className="rg-score">{g.scores[0]}-{g.scores[1]}{g.winnerSide === null ? ' · empate' : ''}</span>
  </div>
)

const RondaBlock = ({ label, winsL, winsR, games, current }) => (
  <div className={`ronda-block ${current ? 'current' : ''}`}>
    <div className="ronda-title">
      <span>{label}</span>
      <span className="ronda-dots"><BoDots wins={winsL} /><span className="dim">vs</span><BoDots wins={winsR} /></span>
    </div>
    {games.map((g, i) => <GameRow g={g} key={g.gameId || i} />)}
  </div>
)

const EnfrentamientoCard = ({ e }) => {
  const [membersL, membersR] = e.sides
  const nameL = membersL.join(' + ')
  const nameR = membersR.join(' + ')
  const [wonL, wonR] = e.rondasWon

  return (
    <div className="enf-card">
      <div className="enf-head">
        <span className={`enf-side ${wonL > wonR ? 'leading' : ''}`}>{nameL}</span>
        <span className="enf-score">{wonL}-{wonR}</span>
        <span className={`enf-side right ${wonR > wonL ? 'leading' : ''}`}>{nameR}</span>
      </div>
      <div className="enf-rondas">
        {e.rondas.map((r, i) => {
          const winsL = r.games.filter(g => g.winnerSide === 0).length
          const winsR = r.games.filter(g => g.winnerSide === 1).length
          return <RondaBlock key={i} label={`Ronda ${i + 1}`} winsL={winsL} winsR={winsR} games={r.games} />
        })}
        {e.current && (
          <RondaBlock
            label={`Ronda ${e.rondas.length + 1} · en juego`}
            winsL={e.current.wins[0]} winsR={e.current.wins[1]}
            games={e.current.games} current
          />
        )}
      </div>
    </div>
  )
}

export const RondasView = ({ navigate }) => {
  const rondas = useApi('/api/stats/rondas')
  const live = rondas.data?.session?.live

  // Mientras la sesión sigue viva, refresca solo cada 60s (el bot ya avisa
  // en el grupo al instante; esto es para quien deja la pestaña abierta).
  useEffect(() => {
    if (!live) return undefined
    const id = setInterval(() => rondas.reload(), 60000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  const session = rondas.data?.session

  return (
    <>
      <div className="secbar">
        <h2>Rondas</h2>
        <span className="note">
          <button className="link-note" onClick={() => navigate('/roster')}>Ver roster</button>
        </span>
      </div>

      {rondas.loading ? <Skeleton variant="cards" rows={3} /> : rondas.error ? (
        <ErrorState message="No se pudo cargar el marcador de rondas." reload={rondas.reload} />
      ) : !session ? <EmptyState>Sin retas registradas.</EmptyState> : (
        <>
          <div className="rondas-meta">
            {session.live && <span className="live-badge">🟢 En vivo</span>}
            {!session.live && <span className="live-badge ended">🔴 Terminada</span>}
            <span className="rondas-date">{session.dateLabel}</span>
            <span className="dim">{session.gamesCount} partida{session.gamesCount !== 1 ? 's' : ''}</span>
          </div>

          <div className="enf-list">
            {session.enfrentamientos.map((e, i) => <EnfrentamientoCard e={e} key={i} />)}
          </div>

          {session.cuenta.length > 0 && (
            <div className="cuenta-noche">
              <div className="secbar gold"><h2>Cuenta de la noche</h2></div>
              {session.cuenta.map((c, i) => (
                <div className="cuenta-row" key={i}>
                  <span>{c.losers.join(' + ')}</span>
                  <span className="dim">deben</span>
                  <b>${c.amountMxn}</b>
                  <span className="dim">a</span>
                  <span>{c.winners.join(' + ')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
