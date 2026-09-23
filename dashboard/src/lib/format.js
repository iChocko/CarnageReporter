// Helpers puros de formato/calculo, sin estado ni dependencias de React.
// Se exportan por separado para poder probarlos directo (Fase C3).

export function formatCDMX(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(timestamp))
  const get = t => (parts.find(p => p.type === t) || {}).value || ''
  return { dateStr: `${get('day')}/${get('month')}/${get('year')}`, timeStr: `${get('hour')}:${get('minute')}` }
}

/** "Martes 22 de septiembre" (día de CDMX) para encabezar una reta. */
export function formatDayCDMX(timestamp) {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long'
  }).formatToParts(new Date(timestamp))
  const get = t => (parts.find(p => p.type === t) || {}).value || ''
  const weekday = get('weekday')
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${get('day')} de ${get('month')}`
}

// Más de 3 h sin partidas entre una y otra = retas distintas.
export const SESSION_GAP_MS = 3 * 60 * 60 * 1000

/**
 * Agrupa partidas (más reciente primero, como llegan de /api/stats/recent)
 * en retas: la reta sigue mientras no pasen más de `gapMs` entre el final de
 * una partida y el de la siguiente. Una reta que cruza la medianoche queda
 * junta. startTs = inicio de su primera partida (fin - duración).
 * @returns {{ key: string, games: object[], startTs: number, endTs: number }[]}
 */
export function groupSessions(games, gapMs = SESSION_GAP_MS) {
  const sessions = []
  let current = null
  for (const g of games) {
    const endMs = new Date(g.timestamp).getTime()
    if (!current || current.oldestEndMs - endMs > gapMs) {
      current = { key: g.game_unique_id, games: [], endTs: endMs, oldestEndMs: endMs, startTs: endMs }
      sessions.push(current)
    }
    current.games.push(g)
    current.oldestEndMs = endMs
    current.startTs = endMs - Math.max(0, g.duration || 0) * 1000
  }
  return sessions.map(s => ({ key: s.key, games: s.games, startTs: s.startTs, endTs: s.endTs }))
}

export const kdOf = p => p.deaths > 0 ? (p.kills / p.deaths) : p.kills
export const kdaOf = p => p.deaths > 0 ? ((p.kills + p.assists) / p.deaths) : (p.kills + p.assists)
export const fmt2 = n => (Math.round(n * 100) / 100).toFixed(2)

export const TIER_CLASS = { 'Pro': 'pro', 'Semi-Pro': 'semi', 'Competitive': 'comp', 'Amateur': '', 'Placement': 'place' }

export function recordStr(p) {
  if (p.wins === undefined) return '—'
  const base = `${p.wins}-${p.losses}`
  return p.draws > 0 ? `${base}-${p.draws}E` : base
}

/**
 * Analiza una partida (con players anidados): equipos ordenados por puntuación
 * (ganador primero), empate, y MVP (mejor KDA; desempate por puntuación).
 */
export function analyzeMatch(game) {
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
