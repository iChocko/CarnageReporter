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
