import { analyzeMatch, fmt2, formatCDMX, kdOf, kdaOf } from '../lib/format'

export const MatchCard = ({ game }) => {
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
