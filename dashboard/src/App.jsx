import React, { useEffect, useState } from 'react'
import { Trophy, Activity, Target, Shield, Users, Clock, Award, Crosshair, TriangleAlert } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'

const API_BASE_URL = '/api/stats'

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
          <h1>HALO 3 CUSTOMS</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>CARNAGE REPORTER - ESTADÍSTICAS GLOBALES</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ color: 'var(--accent-cyan)', fontFamily: 'Outfit', fontWeight: 700 }}>LIVE FEED</p>
          <p style={{ fontSize: '0.75rem', opacity: 0.6 }}>STATUS: OPERATIONAL</p>
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
              DESTACADOS DEL COMBATE
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1.5rem'
            }}>
              {mvpData.mvp && (
                <PerformerCard
                  title="MVP"
                  subtitle="RATIO LETAL"
                  player={mvpData.mvp}
                  stat={mvpData.mvp.overall_kd}
                  icon={<Trophy size={20} />}
                  color="var(--accent-gold)"
                />
              )}
              {mvpData.topSlayer && (
                <PerformerCard
                  title="ASESINO SUPREMO"
                  subtitle="TOTAL DE BAJAS"
                  player={mvpData.topSlayer}
                  stat={mvpData.topSlayer.total_kills}
                  icon={<Crosshair size={20} />}
                  color="var(--accent-cyan)"
                />
              )}
              {mvpData.topSupport && (
                <PerformerCard
                  title="APOYO TÁCTICO"
                  subtitle="ASISTENCIAS"
                  player={mvpData.topSupport}
                  stat={mvpData.topSupport.total_assists}
                  icon={<Shield size={20} />}
                  color="#5c7aff"
                />
              )}
              {mvpData.spreeKing && (
                <PerformerCard
                  title="RACHA LETAL"
                  subtitle="MEJOR SPREE"
                  player={mvpData.spreeKing}
                  stat={mvpData.spreeKing.best_spree}
                  icon={<Target size={20} />}
                  color="#ff5c5c"
                />
              )}
              {mvpData.mostActive && (
                <PerformerCard
                  title="MÁS ACTIVO"
                  subtitle="PARTIDAS JUGADAS"
                  player={mvpData.mostActive}
                  stat={mvpData.mostActive.total_games}
                  icon={<Activity size={20} />}
                  color="var(--text-secondary)"
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

                  <div className="match-roster-grid">
                    <div className="roster-team blue">
                      {blueTeam.map(p => (
                        <span key={p.gamertag} className="roster-player">{p.gamertag}</span>
                      ))}
                    </div>
                    <div className="roster-vs">VS</div>
                    <div className="roster-team red">
                      {redTeam.map(p => (
                        <span key={p.gamertag} className="roster-player">{p.gamertag}</span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }) : <p style={{ opacity: 0.5 }}>No hay partidas recientes registradas.</p>}
          </div>
        </section>

        {/* Leaderboard */}
        <section className="section-panel">
          <h2 className="section-title"><Shield size={20} /> Top Combatientes</h2>
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rango</th>
                <th>Jugador</th>
                <th>Score</th>
                <th>K/D</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard && leaderboard.length > 0 ? leaderboard.slice(0, 10).map((player, index) => (
                <tr key={player.gamertag}>
                  <td><div className="rank-badge">{index + 1}</div></td>
                  <td>
                    <div className="gamertag">{player.gamertag}</div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{player.total_games} partidas</div>
                  </td>
                  <td style={{ fontFamily: 'Outfit', fontWeight: 600 }}>{player.total_score}</td>
                  <td style={{ color: player.overall_kd >= 1 ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
                    {player.overall_kd}
                  </td>
                </tr>
              )) : <tr><td colSpan="4" style={{ textAlign: 'center', opacity: 0.5 }}>No hay datos de jugadores.</td></tr>}
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
