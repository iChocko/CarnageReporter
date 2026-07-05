import React, { useEffect, useMemo, useState } from 'react'
import { StripePaymentModal } from './StripePaymentModal'

const API = '/api/stats'
const DISCORD_URL = 'https://discord.gg/yD6nGZ3KQX'
const GITHUB_URL = 'https://github.com/iChocko/CarnageReporter'

// ---------- Helpers ----------

function formatCDMX(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(timestamp))
  const get = t => (parts.find(p => p.type === t) || {}).value || ''
  return { dateStr: `${get('day')}/${get('month')}/${get('year')}`, timeStr: `${get('hour')}:${get('minute')}` }
}

const kdOf = p => p.deaths > 0 ? (p.kills / p.deaths) : p.kills
const kdaOf = p => p.deaths > 0 ? ((p.kills + p.assists) / p.deaths) : (p.kills + p.assists)
const fmt2 = n => (Math.round(n * 100) / 100).toFixed(2)

/**
 * Analiza una partida (con players anidados): equipos ordenados por puntuación
 * (ganador primero), empate, y MVP (mejor KDA; desempate por puntuación).
 */
function analyzeMatch(game) {
  const teamsMap = new Map()
  for (const p of game.players || []) {
    const tid = p.team_id ?? 0
    if (!teamsMap.has(tid)) teamsMap.set(tid, { tid, members: [], score: 0 })
    const t = teamsMap.get(tid)
    t.members.push(p)
    t.score += p.score
  }
  const teams = [...teamsMap.values()]
    .map(t => ({ ...t, members: [...t.members].sort((a, b) => b.score - a.score) }))
    .sort((a, b) => b.score - a.score)

  const isDraw = teams.length >= 2 && teams[0].score === teams[1].score
  const players = game.players || []
  const mvp = players.length
    ? [...players].sort((a, b) => (kdaOf(b) - kdaOf(a)) || (b.score - a.score))[0]
    : null

  // Color de banda según el team_id ganador (convención: 0=azul, 1=rojo)
  const winnerTid = teams[0]?.tid
  const band = isDraw
    ? { text: 'Empate', cls: 'draw' }
    : { text: winnerTid === 1 ? 'Red Team' : 'Blue Team', cls: winnerTid === 1 ? 'red' : 'blue' }

  return { teams, isDraw, mvp, band }
}

const TIER_CLASS = { 'Pro': 'pro', 'Semi-Pro': 'semi', 'Competitive': 'comp', 'Amateur': '', 'Placement': 'place' }

function recordStr(p) {
  if (p.wins === undefined) return '—'
  const base = `${p.wins}-${p.losses}`
  return p.draws > 0 ? `${base}-${p.draws}E` : base
}

async function getJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------- Componentes compartidos ----------

const EmptyState = ({ children }) => (
  <div className="empty-state">
    <div className="big">🎮</div>
    {children || 'Aún no hay partidas registradas. ¡Jueguen la primera custom 2v2!'}
  </div>
)

const MatchCard = ({ game }) => {
  const { teams, isDraw, mvp } = analyzeMatch(game)
  const { dateStr, timeStr } = formatCDMX(game.timestamp)
  if (teams.length < 2) return null
  const [left, right] = teams
  const names = t => t.members.map(p => p.gamertag).join(' · ')

  return (
    <div className="mcard">
      <div className="mc-top">
        <span className="mc-map">{game.map_name}</span>
        <span className="mc-date">{dateStr} · {timeStr}</span>
      </div>
      <div className="mc-body">
        <div className={`mc-side ${isDraw ? '' : 'winner'}`}><span className="names">{names(left)}</span></div>
        <div className="mc-pill">
          <span className={left.tid === 1 ? 'r' : 'b'}>{left.score}</span>
          <span className="sep">–</span>
          <span className={right.tid === 1 ? 'r' : 'b'}>{right.score}</span>
        </div>
        <div className="mc-side right"><span className="names">{names(right)}</span></div>
      </div>
      <div className="mc-foot">
        {isDraw && <span className="mc-tag">Empate 🤝</span>}
        {mvp && <span>★ MVP: <b>{mvp.gamertag}</b> <span className="dim">KD {fmt2(kdOf(mvp))} · KDA {fmt2(kdaOf(mvp))}</span></span>}
      </div>
    </div>
  )
}

const MatchHero = ({ game }) => {
  const { teams, mvp, band } = analyzeMatch(game)
  const { dateStr, timeStr } = formatCDMX(game.timestamp)
  const duration = game.duration > 0
    ? `${Math.floor(game.duration / 60)}:${String(game.duration % 60).padStart(2, '0')}`
    : null

  return (
    <div className="match-hero">
      <div className="mh-head">
        <div>
          <div className="map">{game.map_name}</div>
          <div className="gt">{game.game_type_name} · 2v2</div>
        </div>
        <div className="meta">
          <div><b>{dateStr}</b> {timeStr} hrs</div>
          {duration && <div>Duración {duration}</div>}
        </div>
      </div>
      <div className={`winner-band ${band.cls}`}>{band.text}</div>
      <div className="team-block">
        {teams.map(team => (
          <React.Fragment key={team.tid}>
            <div className={`team-row ${team.tid === 1 ? 't-red' : 't-blue'}`}>
              <span className="tt">{team.tid === 1 ? 'Red' : 'Blue'}</span>
              <span className="pts">{team.score}</span>
            </div>
            {team.members.map(p => (
              <div className="player-line" key={p.gamertag}>
                <span className={`pl-name ${mvp && p.gamertag === mvp.gamertag ? '' : 'dim'}`}>
                  {mvp && p.gamertag === mvp.gamertag && <span className="mvp-star">★ </span>}
                  {p.gamertag}
                  {mvp && p.gamertag === mvp.gamertag && <span className="mvp-tag">MVP</span>}
                </span>
                <span className="pl-stats">
                  {p.kills} / {p.deaths} / {p.assists} &nbsp;·&nbsp; KD <b>{fmt2(kdOf(p))}</b> &nbsp;·&nbsp; KDA <b>{fmt2(kdaOf(p))}</b>
                </span>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

// ---------- Vistas ----------

const RankingsView = ({ leaderboard, recent, onOpenProfile, onSeeAll }) => (
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
      {leaderboard.length === 0 ? <EmptyState /> : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="c">#</th><th>Jugador</th><th className="c">KD</th>
                <th className="c">KDA</th><th className="c">V-D</th><th className="c">Tier</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((p, i) => (
                <tr key={p.gamertag} className="clickable" tabIndex={0}
                    onClick={() => onOpenProfile(p.gamertag)}
                    onKeyDown={e => e.key === 'Enter' && onOpenProfile(p.gamertag)}>
                  <td className="c rank-col">{p.is_placement ? '—' : i + 1}</td>
                  <td>
                    <span className="player-name" style={p.is_placement ? { color: 'var(--steel-dim)' } : undefined}>{p.gamertag}</span>
                    <br /><span className="games-sub">{p.total_games} partidas</span>
                  </td>
                  <td className="c">{p.overall_kd}</td>
                  <td className={`c ${p.kda >= 1 ? 'kd-pos' : 'kd-neg'}`}>{p.kda}</td>
                  <td className="c">{recordStr(p)}</td>
                  <td className="c"><span className={`tier ${TIER_CLASS[p.tier] ?? ''}`}>{p.tier}</span></td>
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
      {recent.length === 0 ? <EmptyState /> : (
        <>
          <MatchHero game={recent[0]} />
          {recent.length > 1 && (
            <>
              <div className="secbar" style={{ marginTop: 20 }}>
                <h2>Recientes</h2>
                <button className="tab" style={{ border: '1px solid var(--line)', padding: '5px 12px', fontSize: 11 }} onClick={onSeeAll}>
                  Ver todas
                </button>
              </div>
              <div className="match-list">
                {recent.slice(1, 4).map(g => <MatchCard key={g.game_unique_id} game={g} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  </div>
)

const PartidasView = ({ recent }) => (
  <>
    <div className="secbar">
      <h2>Historial de partidas</h2>
      <span className="note">Solo customs 2v2 válidas · hora CDMX</span>
    </div>
    {recent.length === 0 ? <EmptyState /> : (
      <div className="match-list">
        {recent.map(g => <MatchCard key={g.game_unique_id} game={g} />)}
      </div>
    )}
  </>
)

const H2HView = ({ players }) => {
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const compare = async () => {
    setLoading(true); setError(null); setData(null)
    try {
      setData(await getJSON(`${API}/h2h?p1=${encodeURIComponent(p1)}&p2=${encodeURIComponent(p2)}`))
    } catch (e) {
      setError('No se pudo comparar. Intenta de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const winrate = data && data.duo.total > 0 ? Math.round((data.duo.wins / data.duo.total) * 100) : null

  return (
    <>
      <div className="secbar"><h2>Head to Head</h2><span className="note">Como rivales y como dupla</span></div>
      <div className="h2h-pickers">
        <select className="select-steel" value={p1} onChange={e => setP1(e.target.value)} aria-label="Jugador 1">
          <option value="">Jugador 1...</option>
          {players.map(p => <option key={p.gamertag} value={p.gamertag}>{p.gamertag}</option>)}
        </select>
        <span className="vs">VS</span>
        <select className="select-steel" value={p2} onChange={e => setP2(e.target.value)} aria-label="Jugador 2">
          <option value="">Jugador 2...</option>
          {players.map(p => <option key={p.gamertag} value={p.gamertag}>{p.gamertag}</option>)}
        </select>
        <button className="btn-steel" disabled={!p1 || !p2 || p1 === p2 || loading} onClick={compare}>
          {loading ? 'Comparando...' : 'Comparar'}
        </button>
      </div>
      {error && <p className="error-note">{error}</p>}
      {players.length === 0 && <EmptyState>Se necesitan jugadores registrados para comparar.</EmptyState>}
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

const PerfilView = ({ players, selected, onSelect }) => {
  const [query, setQuery] = useState('')
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!selected) { setProfile(null); return }
    let cancelled = false
    setLoading(true); setError(null)
    getJSON(`${API}/player/${encodeURIComponent(selected)}`)
      .then(d => { if (!cancelled) setProfile(d) })
      .catch(() => { if (!cancelled) setError(`No se encontró el perfil de "${selected}".`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selected])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? players.filter(p => p.gamertag.toLowerCase().includes(q)) : players
  }, [players, query])

  // Coincidencia única en el buscador -> cargar directo
  useEffect(() => {
    if (query.trim() && filtered.length === 1 && filtered[0].gamertag !== selected) {
      onSelect(filtered[0].gamertag)
    }
  }, [query, filtered, selected, onSelect])

  return (
    <>
      <div className="secbar"><h2>Perfil de jugador</h2><span className="note">Busca por gamertag</span></div>
      <div className="player-picker">
        <input type="search" className="input-steel" placeholder="Buscar gamertag..."
               aria-label="Buscar jugador por gamertag" autoComplete="off"
               value={query} onChange={e => setQuery(e.target.value)} />
        <div className="player-chips">
          {filtered.map(p => (
            <button key={p.gamertag} className={`pchip ${p.gamertag === selected ? 'active' : ''}`}
                    onClick={() => onSelect(p.gamertag)}>
              {p.gamertag}
            </button>
          ))}
        </div>
      </div>

      {players.length === 0 && <EmptyState />}
      {loading && <p className="games-sub">Cargando perfil...</p>}
      {error && <p className="error-note">{error}</p>}

      {profile && !loading && (
        <>
          <div className="profile-head">
            <div className="pname">{profile.gamertag}</div>
          </div>
          <div className="pstats">
            <div className="pstat"><b>{profile.games}</b><span>Partidas</span></div>
            <div className="pstat"><b>{profile.wins}</b><span>Victorias</span></div>
            <div className="pstat"><b>{profile.losses}</b><span>Derrotas</span></div>
            {profile.draws > 0 && <div className="pstat"><b>{profile.draws}</b><span>Empates</span></div>}
            <div className="pstat"><b>{profile.kills}</b><span>Bajas</span></div>
            <div className="pstat"><b>{profile.kd.toFixed(2)}</b><span>K/D</span></div>
            <div className="pstat"><b>{profile.kda.toFixed(2)}</b><span>KDA</span></div>
            <div className="pstat"><b>{profile.bestSpree}</b><span>Mejor racha</span></div>
          </div>
          <div className="secbar"><h2>Historial</h2></div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Mapa</th><th>Fecha</th><th className="c">Resultado</th><th className="c">B / M / A</th><th className="c">K/D</th></tr>
              </thead>
              <tbody>
                {profile.history.map(h => {
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

// ---------- App ----------

const App = () => {
  const [view, setView] = useState('rankings')
  const [leaderboard, setLeaderboard] = useState([])
  const [recent, setRecent] = useState([])
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [stripeOpen, setStripeOpen] = useState(false)

  useEffect(() => {
    Promise.allSettled([
      getJSON(`${API}/leaderboard?limit=50`),
      getJSON(`${API}/recent`),
      getJSON(`${API}/players`)
    ]).then(([l, r, p]) => {
      if (l.status === 'fulfilled') setLeaderboard(l.value || [])
      if (r.status === 'fulfilled') setRecent(r.value || [])
      if (p.status === 'fulfilled') setPlayers(p.value || [])
      setLoading(false)
    })
  }, [])

  const openProfile = (gamertag) => {
    setSelectedPlayer(gamertag)
    setView('perfil')
  }

  if (loading) {
    return <div className="loading">Cargando Carnage Reporter...</div>
  }

  const TABS = [
    ['rankings', 'Rankings'],
    ['partidas', 'Partidas'],
    ['h2h', 'H2H'],
    ['perfil', 'Perfil'],
  ]

  return (
    <div className="wrap">
      <header className="site">
        <div className="brand">
          <div className="kicker">Post Game Carnage Report</div>
          <h1>Carnage Reporter</h1>
          <div className="sub">Halo 3 MCC · Customs 2v2 · Comunidad Retas H3</div>
        </div>
        <div className="head-right">
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">Discord ↗</a>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Secciones">
        {TABS.map(([id, label]) => (
          <button key={id} className="tab" role="tab" aria-selected={view === id} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>

      <section className="view">
        {view === 'rankings' && (
          <RankingsView leaderboard={leaderboard} recent={recent}
                        onOpenProfile={openProfile} onSeeAll={() => setView('partidas')} />
        )}
        {view === 'partidas' && <PartidasView recent={recent} />}
        {view === 'h2h' && <H2HView players={players} />}
        {view === 'perfil' && (
          <PerfilView players={players} selected={selectedPlayer} onSelect={setSelectedPlayer} />
        )}
      </section>

      <footer className="site">
        <span>Carnage Reporter · H3 MCC</span>
        <span>
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">Discord</a>
          {' · '}
          <a href="https://paypal.me/xChocko" target="_blank" rel="noopener noreferrer">PayPal</a>
          {' · '}
          <button onClick={() => setStripeOpen(true)}>Apoyar el proyecto</button>
          {' · '}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </span>
      </footer>

      <StripePaymentModal isOpen={stripeOpen} onClose={() => setStripeOpen(false)} />
    </div>
  )
}

export default App
