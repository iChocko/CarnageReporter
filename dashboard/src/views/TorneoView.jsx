import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { ErrorState } from '../components/ErrorState'
import { Skeleton } from '../components/Skeleton'
import { fmt2, formatCDMX } from '../lib/format'

const MODO_LABEL = { ctf: 'CTF', slayer: 'Slayer', oddball: 'Oddball', koth: 'KOTH' }
const ESTADO_LABEL = {
  pendiente: 'Pendiente', en_curso: 'En curso', terminada: 'Terminada', wo: 'W.O.', empatada: 'Empate', cancelada: 'Cancelada',
}
const INTENTO_LABEL = { reiniciada: 'reiniciada', empate: 'empate · se repitió', cuenta: 'cuenta' }
const SECCIONES = [['tabla', 'Tabla'], ['series', 'Series'], ['jugadores', 'Jugadores']]

/** Nombre de equipo con su color del póster. */
const TeamTag = ({ team, strong }) => (
  <span className={`t-tag ${strong ? 'strong' : ''}`}>
    <span className="t-dot" style={{ background: team?.color || 'var(--steel-dim)' }} aria-hidden="true" />
    {team?.nombre || '?'}
  </span>
)

const Tabla = ({ data, teamById }) => {
  const [open, setOpen] = useState(null)
  const playersByTeam = useMemo(() => {
    const m = new Map()
    for (const p of data.players) {
      if (!m.has(p.equipo)) m.set(p.equipo, [])
      m.get(p.equipo).push(p)
    }
    return m
  }, [data.players])

  return (
    <div className="tablewrap">
      <table className="torneo-tabla">
        <thead>
          <tr>
            <th className="c rank-col">#</th>
            <th>Equipo</th>
            <th className="c" title="Series jugadas">PJ</th>
            <th className="c" title="Ganadas">PG</th>
            <th className="c" title="Empatadas">PE</th>
            <th className="c" title="Perdidas">PP</th>
            <th className="c hide-sm" title="Games ganados-perdidos">Games</th>
            <th className="c" title="Diferencia de games">Dif</th>
            <th className="c hide-sm">K/D</th>
            <th className="c pts-col">Pts</th>
          </tr>
        </thead>
        <tbody>
          {data.standings.map(r => (
            <TablaRow key={r.id} r={r} team={teamById.get(r.id)} open={open === r.id}
                      onToggle={() => setOpen(open === r.id ? null : r.id)}
                      roster={playersByTeam.get(r.id) || []} />
          ))}
        </tbody>
      </table>
      <p className="dim torneo-hint">
        Puntos por serie: victoria 3, empate 1, derrota 0. Desempate: diferencia de games, enfrentamiento directo,
        más games ganados y, si siguen iguales, partida extra. Toca un equipo para ver a sus jugadores.
      </p>
    </div>
  )
}

const TablaRow = ({ r, team, open, onToggle, roster }) => (
  <>
    <tr className="clickable" onClick={onToggle} aria-expanded={open}>
      <td className="c rank-col">{r.pos}</td>
      <td className="player-name">
        <TeamTag team={team} strong />
        {r.desempateExtra && <span className="sub-tag" title="Empate en todos los criterios">partida extra</span>}
      </td>
      <td className="c">{r.pj}</td>
      <td className="c">{r.pg}</td>
      <td className="c">{r.pe}</td>
      <td className="c">{r.pp}</td>
      <td className="c hide-sm">{r.partidasGanadas}-{r.partidasPerdidas}</td>
      <td className={`c ${r.difPartidas > 0 ? 'res-w' : r.difPartidas < 0 ? 'res-l' : ''}`}>
        {r.difPartidas > 0 ? `+${r.difPartidas}` : r.difPartidas}
      </td>
      <td className="c hide-sm">{fmt2(r.kd)}</td>
      <td className="c pts-col"><b>{r.puntos}</b></td>
    </tr>
    {open && (
      <tr className="roster-row">
        <td colSpan={10}>
          <div className="torneo-roster">
            {roster.map(p => (
              <div className="tr-player" key={p.nombre}>
                <span className="player-name">
                  {p.capitan && <span className="cap-tag" title="Capitán">C</span>}
                  {p.nombre}
                  {!p.titular && <span className="sub-tag">{p.registrado ? 'suplente' : 'no registrado'}</span>}
                </span>
                <span className="dim">{p.gamertags.join(' · ') || 'sin partidas'}</span>
                <span className="tr-stats">
                  {p.pj} PJ · {p.kills}/{p.deaths}/{p.assists} · KDA <b>{fmt2(p.kda)}</b>
                  {p.mvps > 0 && <> · ★ {p.mvps}</>}
                </span>
              </div>
            ))}
          </div>
        </td>
      </tr>
    )}
  </>
)

/** Scoreboard de una partida del torneo (lados con nombre y color del equipo). */
const Scoreboard = ({ partida, teamById }) => (
  <div className="t-score">
    <div className="dim t-score-meta">
      {partida.mapa} · {partida.gameType} · {formatCDMX(partida.timestamp).dateStr} {formatCDMX(partida.timestamp).timeStr} hrs · ID {partida.gameId.slice(0, 8)}
    </div>
    {partida.lados.map(l => (
      <div className="t-side" key={l.equipo}>
        <div className="t-side-head">
          <TeamTag team={teamById.get(l.equipo)} strong />
          <span className="pts">{l.puntos}</span>
        </div>
        {l.jugadores.map(j => (
          <div className="player-line" key={j.gamertag}>
            <span className="pl-name">
              {j.nombre !== j.gamertag ? j.nombre : j.gamertag}
              {j.suplente && <span className="sub-tag">{j.registrado ? 'suplente' : 'no registrado'}</span>}
              {j.dc && <span className="dc-tag" title="No terminó la partida (desconexión)">DC</span>}
            </span>
            <span className="pl-stats">{j.kills} / {j.deaths} / {j.assists}</span>
          </div>
        ))}
      </div>
    ))}
  </div>
)

const SerieCard = ({ s, teamById, partidaById }) => {
  const [open, setOpen] = useState(null)
  const a = teamById.get(s.a)
  const b = teamById.get(s.b)
  const lead = s.marcador[s.a] === s.marcador[s.b] ? null : (s.marcador[s.a] > s.marcador[s.b] ? s.a : s.b)

  return (
    <div className={`serie-card estado-${s.estado}`}>
      <div className="serie-head">
        <span className="serie-n">{s.n}</span>
        <span className={`serie-team ${lead === s.a ? 'leading' : ''}`}><TeamTag team={a} strong /></span>
        <span className="serie-score">{s.marcador[s.a]}-{s.marcador[s.b]}</span>
        <span className={`serie-team right ${lead === s.b ? 'leading' : ''}`}><TeamTag team={b} strong /></span>
        <span className={`serie-estado e-${s.estado}`}>{ESTADO_LABEL[s.estado]}</span>
      </div>
      {s.wo && <div className="serie-note">W.O. a favor de {teamById.get(s.wo.ganador)?.nombre}{s.wo.nota ? ` · ${s.wo.nota}` : ''}</div>}
      {s.empate && <div className="serie-note">Empate declarado por los organizadores{s.empate.nota ? ` · ${s.empate.nota}` : ''}</div>}
      <div className="serie-games">
        {s.games.map(g => {
          const partida = g.gameId ? partidaById.get(g.gameId) : null
          const extra = g.intentos.filter(i => i.gameId !== g.gameId)
          const winner = g.ganador ? teamById.get(g.ganador) : null
          const canOpen = Boolean(partida) || extra.length > 0
          return (
            <div className="serie-game" key={g.slot}>
              <button className={`sg-row ${winner ? 'played' : ''}`} disabled={!canOpen}
                      onClick={() => setOpen(open === g.slot ? null : g.slot)} aria-expanded={open === g.slot}
                      aria-label={`Game ${g.slot}: ${g.mapa} ${MODO_LABEL[g.modo]}, ${winner ? `gana ${winner.nombre}` : 'pendiente'}`}>
                <span className="sg-slot">G{g.slot}</span>
                <span className="sg-map">{g.mapa}</span>
                <span className="sg-modo">{MODO_LABEL[g.modo]}</span>
                <span className="sg-res">
                  {winner ? (
                    <>
                      <span className="t-dot" style={{ background: winner.color }} aria-hidden="true" />
                      {winner.nombre}
                      {g.marcador && <span className="dim"> {g.marcador[g.ganador]}-{g.marcador[g.ganador === s.a ? s.b : s.a]}</span>}
                      {g.manual && <span className="sub-tag">manual</span>}
                    </>
                  ) : <span className="dim">{s.estado === 'cancelada' ? '—' : 'pendiente'}</span>}
                </span>
              </button>
              {open === g.slot && (
                <div className="sg-detail">
                  {partida && <Scoreboard partida={partida} teamById={teamById} />}
                  {extra.map(i => (
                    <div key={i.gameId} className="sg-intento">
                      <span className="dim">{formatCDMX(i.timestamp).timeStr} hrs · {i.gameId.slice(0, 8)}</span>
                      <span>{INTENTO_LABEL[i.estado] || i.estado}</span>
                      {partidaById.get(i.gameId) && <Scoreboard partida={partidaById.get(i.gameId)} teamById={teamById} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const COLUMNS = [
  ['pj', 'PJ'], ['ganadas', 'G'], ['kills', 'K'], ['deaths', 'D'], ['assists', 'A'],
  ['kd', 'K/D'], ['kda', 'KDA'], ['mvps', 'MVP'],
]
const HIDE_SM = new Set(['ganadas', 'assists', 'deaths', 'mvps'])

const Jugadores = ({ data, teamById }) => {
  const [team, setTeam] = useState('todos')
  const [sort, setSort] = useState('kda')
  const rows = useMemo(() => data.players
    .filter(p => team === 'todos' || p.equipo === team)
    .slice()
    .sort((x, y) => (y.pj > 0) - (x.pj > 0) || (y[sort] - x[sort]) || x.nombre.localeCompare(y.nombre)),
  [data.players, team, sort])

  return (
    <>
      <div className="pchips torneo-filtros">
        <button className={`pchip ${team === 'todos' ? 'active' : ''}`} onClick={() => setTeam('todos')}>Todos</button>
        {data.torneo.equipos.map(e => (
          <button key={e.id} className={`pchip ${team === e.id ? 'active' : ''}`} onClick={() => setTeam(e.id)}>
            <TeamTag team={e} />
          </button>
        ))}
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Jugador</th>
              {COLUMNS.map(([k, label]) => (
                <th key={k} className={`c sortable ${HIDE_SM.has(k) ? 'hide-sm' : ''} ${sort === k ? 'sorted' : ''}`}
                    onClick={() => setSort(k)} aria-sort={sort === k ? 'descending' : 'none'}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr key={`${p.equipo}:${p.nombre}`} className={p.pj === 0 ? 'dim' : ''}>
                <td className="player-name wrap-sm">
                  <span className="cell-name">{p.nombre}</span>
                  {!p.titular && <span className="sub-tag">{p.registrado ? 'suplente' : 'no registrado'}</span>}
                  {p.dcs > 0 && <span className="dc-tag" title="Partidas sin terminar (desconexión)">DC {p.dcs}</span>}
                  <span className="sub-line"><TeamTag team={teamById.get(p.equipo)} /></span>
                </td>
                {COLUMNS.map(([k]) => (
                  <td key={k} className={`c ${HIDE_SM.has(k) ? 'hide-sm' : ''} ${sort === k ? 'sorted' : ''}`}>
                    {k === 'kd' || k === 'kda' ? fmt2(p[k]) : p[k]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim torneo-hint">Cuentan las partidas oficiales y los empates; no cuentan reinicios, resultados manuales ni W.O.</p>
    </>
  )
}

/**
 * Sección del torneo activo. Recibe el resultado de useApi('/api/stats/torneo')
 * desde App (que también decide si mostrar la pestaña).
 */
export const TorneoView = ({ torneo }) => {
  const [seccion, setSeccion] = useState('tabla')
  const data = torneo.data
  const enCurso = Boolean(data?.series?.some(s => s.estado === 'en_curso'))

  // Con una serie en juego, refresca cada 60s (el bot ya avisa en el grupo).
  useEffect(() => {
    if (!enCurso) return undefined
    const id = setInterval(() => torneo.reload(), 60000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enCurso])

  const teamById = useMemo(() => new Map((data?.torneo.equipos || []).map(e => [e.id, e])), [data])
  const partidaById = useMemo(() => new Map((data?.partidas || []).map(p => [p.gameId, p])), [data])

  if (torneo.loading) return <Skeleton variant="table" rows={5} />
  if (torneo.error?.status === 404) return <EmptyState>No hay torneo activo.</EmptyState>
  if (torneo.error || !data) return <ErrorState message="No se pudo cargar el torneo." reload={torneo.reload} />

  const jugadas = data.series.filter(s => ['terminada', 'wo', 'empatada'].includes(s.estado)).length

  return (
    <>
      <div className="secbar gold">
        <h2>{data.torneo.nombre}</h2>
        <span className="note">
          Round robin · Bo{data.torneo.bo} · {jugadas}/{data.series.length} series
          {enCurso && <span className="live-badge">🟢 En juego</span>}
        </span>
      </div>

      <div className="pchips torneo-secciones" role="tablist" aria-label="Secciones del torneo">
        {SECCIONES.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={seccion === id}
                  className={`pchip ${seccion === id ? 'active' : ''}`} onClick={() => setSeccion(id)}>{label}</button>
        ))}
      </div>

      {seccion === 'tabla' && <Tabla data={data} teamById={teamById} />}
      {seccion === 'series' && (
        <div className="serie-list">
          {data.series.map(s => <SerieCard key={s.n} s={s} teamById={teamById} partidaById={partidaById} />)}
        </div>
      )}
      {seccion === 'jugadores' && <Jugadores data={data} teamById={teamById} />}

      {data.revisar > 0 && (
        <p className="dim torneo-hint">⚠️ {data.revisar} partida{data.revisar !== 1 ? 's' : ''} pendiente{data.revisar !== 1 ? 's' : ''} de revisión por los organizadores.</p>
      )}
    </>
  )
}
