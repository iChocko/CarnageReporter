import React from 'react'
import { Award } from 'lucide-react'

export const LeaderboardCard = ({ player, index }) => {
    return (
        <div className="leaderboard-card-mobile">
            <div className="card-header">
                <div className="card-player-info">
                    <div className="rank-badge">{index + 1}</div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div className="gamertag" style={{ fontSize: '1.1rem' }}>{player.gamertag}</div>
                        <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{player.total_games} games</div>
                    </div>
                </div>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    borderRadius: '3px',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    backgroundColor: `${player.tier_color}20`,
                    color: player.tier_color,
                    border: `1px solid ${player.tier_color}`
                }}>
                    {player.tier === 'Pro' ? '🥇' : player.tier === 'Semi-Pro' ? '🥈' : player.tier === 'Competitive' ? '🥉' : ''} {player.tier.toUpperCase()}
                </div>
            </div>

            <div className="card-stats-grid">
                <div className="card-stat-item">
                    <span className="card-stat-label">KD</span>
                    <span className="card-stat-value">{player.overall_kd}</span>
                </div>
                <div className="card-stat-item">
                    <span className="card-stat-label">KDA</span>
                    <span className="card-stat-value" style={{ color: player.kda >= 1.5 ? 'var(--accent-cyan)' : 'inherit' }}>
                        {player.kda}
                    </span>
                </div>
                <div className="card-stat-item">
                    <span className="card-stat-label">Efficiency</span>
                    <span className="card-stat-value" style={{ color: player.efficiency >= 0 ? '#00f2ff' : '#ff5c5c' }}>
                        {player.efficiency > 0 ? `+${player.efficiency}` : player.efficiency}
                    </span>
                </div>
                <div className="card-stat-item">
                    <span className="card-stat-label">Spree</span>
                    <span className="card-stat-value">{player.avg_spree}</span>
                </div>
                <div className="card-stat-item">
                    <span className="card-stat-label">Score</span>
                    <span className="card-stat-value" style={{ color: 'var(--accent-gold)' }}>{player.slayer_score}</span>
                </div>
            </div>
        </div>
    )
}
