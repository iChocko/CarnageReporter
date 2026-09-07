import { DISCORD_URL } from '../lib/links'

const FORMATS = [
  ['2v2', '2v2', 'Customs · Retas H3'],
  ['4v4', '4v4', 'Customs y matchmaking · Torneos H3'],
]

export const Header = ({ format, onFormatChange }) => {
  const sub = FORMATS.find(f => f[0] === format)?.[2] || ''

  return (
    <header className="site">
      <div className="brand">
        <div className="kicker">Post Game Carnage Report</div>
        <h1>Carnage Reporter</h1>
        <div className="sub">Halo 3 MCC · {format.toUpperCase()} · {sub}</div>
      </div>
      <div className="head-right">
        <div className="format-toggle" role="tablist" aria-label="Formato">
          {FORMATS.map(([id, label]) => (
            <button key={id} className={`fmt-btn ${format === id ? 'active' : ''}`}
                    role="tab" aria-selected={format === id} onClick={() => onFormatChange(id)}>
              {label}
            </button>
          ))}
        </div>
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="discord-link">Discord ↗</a>
      </div>
    </header>
  )
}
