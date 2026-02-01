import React, { useEffect, useState } from 'react'
import { Trophy, Activity, Target, Shield, Users, Clock, Award, Crosshair, TriangleAlert } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'

const API_BASE_URL = '/api/stats'

const calculateRatios = (k, d, a) => {
  const kd = d > 0 ? (k / d).toFixed(2) : k.toFixed(2);
  const kda = d > 0 ? ((k + a) / d).toFixed(2) : (k + a).toFixed(2);
  return { kd, kda };
}

const App = () => {
  const [globalStats, setGlobalStats] = useState({
    totalGames: 0,
    totalKills: 0,
    totalDeaths: 0,
    avgKD: 0,
    totalPlayers: 0
  })
  const [mvpData, setMvpData] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [recentGames, setRecentGames] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      const [gRes, lRes, rRes, mRes] = await Promise.all([
        fetch(`${API_BASE_URL}/global`),
        fetch(`${API_BASE_URL}/leaderboard`),
        fetch(`${API_BASE_URL}/recent`),
        fetch(`${API_BASE_URL}/mvp`)
      ])

      const [gData, lData, rData, mData] = await Promise.all([
        gRes.json(),
        lRes.json(),
        rRes.json(),
        mRes.json()
      ])

      setGlobalStats(gData)
      setLeaderboard(lData)
      setRecentGames(rData)
      setMvpData(mData)

    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="dashboard-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <Activity className="animate-pulse" size={64} color="#00f2ff" />
          <p style={{ marginTop: '1rem', fontFamily: 'Outfit', textTransform: 'uppercase', letterSpacing: '0.2em' }}>
            Accediendo a la RED DE BATTLE.NET...
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard-container">
      <header className="bungie-header">
        <div>
          <h1>MLG HALO 3 LEADERBOARD</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>COMPETITIVE STATS • v8 SETTINGS • CARNAGE REPORTER</p>
        </div>
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
          <div>
            <p style={{ color: 'var(--accent-cyan)', fontFamily: 'Outfit', fontWeight: 700, margin: 0 }}>LIVE FEED</p>
            <p style={{ fontSize: '0.75rem', opacity: 0.6, margin: 0 }}>STATUS: OPERATIONAL</p>
          </div>
          <a
            href="https://discord.gg/yD6nGZ3KQX"
            target="_blank"
            rel="noopener noreferrer"
            title="Join Discord"
            style={{
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.75rem',
              transition: 'color 0.2s',
              opacity: 0.7
            }}
            onMouseOver={(e) => e.currentTarget.style.color = '#5865F2'}
            onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.23 10.23 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.419-2.157 2.419zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.419-2.157 2.419z" />
            </svg>
            DISCORD
          </a>
        </div>
      </header>

      {/* MVP Spotlight */}
      {mvpData && (
        <section style={{ marginBottom: '2rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(42, 109, 189, 0.15), rgba(0, 242, 255, 0.05))',
            border: '2px solid var(--accent-blue)',
            padding: '2rem',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: '150px',
              height: '150px',
              background: 'radial-gradient(circle, rgba(0,242,255,0.2), transparent)',
              pointerEvents: 'none'
            }}></div>
            <h2 style={{
              fontFamily: 'Outfit',
              fontSize: '1.5rem',
              marginBottom: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem'
            }}>
              <Award size={28} color="var(--accent-gold)" />
              MLG HALO 3 • TOP PERFORMERS
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', marginTop: '-1rem' }}>
              Competitive Stats • MLG v8 Settings
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1.5rem'
            }}>
              {mvpData.mvp && (
                <PerformerCard
                  title="👑 HIGHEST KDA"
                  subtitle="MLG EFFICIENCY"
                  player={mvpData.mvp}
                  stat={mvpData.mvp.kda}
                  icon={<Trophy size={20} />}
                  color="var(--accent-gold)"
                />
              )}
              {mvpData.topEfficiency && (
                <PerformerCard
                  title="⚡ BEST EFFICIENCY"
                  subtitle="KILL DIFFERENTIAL"
                  player={mvpData.topEfficiency}
                  stat={mvpData.topEfficiency.efficiency > 0 ? `+${mvpData.topEfficiency.efficiency}` : mvpData.topEfficiency.efficiency}
                  icon={<Target size={20} />}
                  color="var(--accent-cyan)"
                />
              )}
              {mvpData.spreeKing && (
                <PerformerCard
                  title="🔥 SPREE KING"
                  subtitle="LONGEST STREAK"
                  player={mvpData.spreeKing}
                  stat={mvpData.spreeKing.best_spree}
                  icon={<Crosshair size={20} />}
                  color="#ff5c5c"
                />
              )}
              {mvpData.mostConsistent && (
                <PerformerCard
                  title="🎯 MOST CONSISTENT"
                  subtitle="AVG SCORE PER GAME"
                  player={mvpData.mostConsistent}
                  stat={Math.round(mvpData.mostConsistent.total_score / mvpData.mostConsistent.total_games)}
                  icon={<Activity size={20} />}
                  color="#a855f7"
                />
              )}
            </div>
          </div>
        </section>
      )}

      {/* Global KPIs */}
      <div className="stats-grid">
        <StatCard
          label="Customs Totales"
          value={globalStats.totalGames}
          icon={<Trophy size={20} />}
          sub="Partidas personalizadas"
        />
        <StatCard
          label="Bajas Globales"
          value={globalStats.totalKills}
          icon={<Target size={20} />}
          sub="Total de eliminaciones"
        />
        <StatCard
          label="K/D Promedio"
          value={globalStats.avgKD}
          icon={<Activity size={20} />}
          sub="Ratio de combate global"
        />
        <StatCard
          label="Jugadores Únicos"
          value={globalStats.totalPlayers}
          icon={<Users size={20} />}
          sub="Encontrados en la red"
        />
      </div>

      <div className="main-content">
        {/* Recent Games */}
        <section className="section-panel">
          <h2 className="section-title"><Clock size={20} /> Partidas Recientes</h2>
          <div className="match-list">
            {recentGames && recentGames.length > 0 ? recentGames.map(game => {
              const blueTeam = game.players?.filter(p => p.team_id === 0) || [];
              const redTeam = game.players?.filter(p => p.team_id === 1) || [];
              const isGenericMap = game.map_name === 'Halo 3 Match' || game.map_name === 'Halo 3 Map';
              const mapDisplay = isGenericMap ? 'MCC Match' : game.map_name;
              const displayTitle = `${game.game_type_name} @ ${mapDisplay}`;

              return (
                <div key={game.game_unique_id} className="match-card-enhanced">
                  <div className="match-header-row">
                    <div className="match-info-main">
                      <h4>{displayTitle}</h4>
                      <p style={{ opacity: 0.6, fontSize: '0.75rem' }}>
                        {formatDistanceToNow(new Date(game.timestamp), { addSuffix: true, locale: es })}
                      </p>
                    </div>
                    <div className="match-score-pill">
                      <span className="score-blue">{game.blue_score}</span>
                      <span style={{ margin: '0 0.5rem', opacity: 0.3 }}>-</span>
                      <span className="score-red">{game.red_score}</span>
                    </div>
                  </div>

                  <div className="match-roster-grid-enhanced">
                    <div className="roster-team blue">
                      {blueTeam.map(p => {
                        const { kd, kda } = calculateRatios(p.kills, p.deaths, p.assists);
                        return (
                          <div key={p.gamertag} className="player-stat-row">
                            <span className="roster-player">{p.gamertag}</span>
                            <span className="player-brief-stats">
                              {p.kills}/{p.deaths}/{p.assists} • <small>{kd} KD</small>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="roster-vs">VS</div>
                    <div className="roster-team red">
                      {redTeam.map(p => {
                        const { kd, kda } = calculateRatios(p.kills, p.deaths, p.assists);
                        return (
                          <div key={p.gamertag} className="player-stat-row" style={{ textAlign: 'left' }}>
                            <span className="roster-player">{p.gamertag}</span>
                            <span className="player-brief-stats">
                              {p.kills}/{p.deaths}/{p.assists} • <small>{kd} KD</small>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            }) : <p style={{ opacity: 0.5 }}>No hay partidas recientes registradas.</p>}
          </div>
        </section>

        {/* Leaderboard */}
        <section className="section-panel">
          <h2 className="section-title"><Shield size={20} /> MLG Slayer Rankings</h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-1rem', marginBottom: '1rem' }}>
            Ranked by Slayer Score (40% KDA + 30% Efficiency + 30% Spree)
          </p>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>KD</th>
                <th>KDA</th>
                <th>Effic.</th>
                <th>Spree</th>
                <th>Score</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard && leaderboard.length > 0 ? leaderboard.slice(0, 10).map((player, index) => (
                <tr key={player.gamertag}>
                  <td><div className="rank-badge">{index + 1}</div></td>
                  <td>
                    <div className="gamertag">{player.gamertag}</div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{player.total_games} games</div>
                  </td>
                  <td style={{ fontFamily: 'Outfit', fontWeight: 600, opacity: 0.8 }}>
                    {player.overall_kd}
                  </td>
                  <td style={{ fontFamily: 'Outfit', fontWeight: 600, color: player.kda >= 1.5 ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
                    {player.kda}
                  </td>
                  <td style={{ fontFamily: 'Outfit', fontWeight: 600, color: player.efficiency >= 0 ? '#00f2ff' : '#ff5c5c' }}>
                    {player.efficiency > 0 ? `+${player.efficiency}` : player.efficiency}
                  </td>
                  <td style={{ fontFamily: 'Outfit' }}>{player.avg_spree}</td>
                  <td style={{ fontFamily: 'Outfit', fontWeight: 700, color: 'var(--accent-gold)' }}>{player.slayer_score}</td>
                  <td>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: '3px',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      backgroundColor: `${player.tier_color}20`,
                      color: player.tier_color,
                      border: `1px solid ${player.tier_color}`
                    }}>
                      {player.tier === 'Pro' ? '🥇' : player.tier === 'Semi-Pro' ? '🥈' : player.tier === 'Competitive' ? '🥉' : ''} {player.tier.toUpperCase()}
                    </span>
                  </td>
                </tr>
              )) : <tr><td colSpan="7" style={{ textAlign: 'center', opacity: 0.5 }}>No player data available.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <footer style={{
        marginTop: '4rem',
        padding: '2rem 0',
        borderTop: '1px solid var(--border-color)',
        textAlign: 'center',
        opacity: 0.5,
        fontSize: '0.75rem'
      }}>
        <p>&copy; 2026 CARNAGE REPORTER • BUNGIE-ERA INTERFACE • HALO 3 MCC CUSTOMS</p>
      </footer>
    </div>
  )
}

const StatCard = ({ label, value, icon, sub }) => (
  <div className="stat-card">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
      <div className="stat-label">{label}</div>
      <div style={{ color: 'var(--accent-blue)' }}>{icon}</div>
    </div>
    <div className="stat-value">{value}</div>
    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{sub}</div>
    <div className="progress-container">
      <div className="progress-bar" style={{ width: '65%' }}></div>
    </div>
  </div>
)

const PerformerCard = ({ title, subtitle, player, stat, icon, color }) => (
  <div style={{
    background: 'rgba(255, 255, 255, 0.03)',
    border: `1px solid ${color}`,
    padding: '1rem',
    position: 'relative'
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
        {title}
      </div>
      <div style={{ color }}>{icon}</div>
    </div>
    <div style={{
      fontFamily: 'Outfit',
      fontSize: '1.5rem',
      fontWeight: 700,
      color,
      marginBottom: '0.25rem'
    }}>
      {stat}
    </div>
    <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
      {player.gamertag}
    </div>
    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
      {subtitle}
    </div>
  </div>
)

export default App
