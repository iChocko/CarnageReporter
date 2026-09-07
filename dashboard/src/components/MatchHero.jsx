import React from 'react'
import { analyzeMatch, fmt2, formatCDMX, kdOf, kdaOf } from '../lib/format'

export const MatchHero = ({ game }) => {
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
