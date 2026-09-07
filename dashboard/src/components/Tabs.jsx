const TABS = [
  ['/rankings', 'rankings', 'Rankings'],
  ['/partidas', 'partidas', 'Partidas'],
  ['/h2h', 'h2h', 'H2H'],
  ['/perfil', 'perfil', 'Perfil'],
]

export const Tabs = ({ view, navigate }) => (
  <nav className="tabs" role="tablist" aria-label="Secciones">
    {TABS.map(([path, id, label]) => (
      <button key={id} className="tab" role="tab" aria-selected={view === id} onClick={() => navigate(path)}>
        {label}
      </button>
    ))}
  </nav>
)
