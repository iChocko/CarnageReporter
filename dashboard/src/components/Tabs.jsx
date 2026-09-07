// /roster se llega desde Rondas/Saldos y el pie de página (no ocupa una tab);
// /admin es admin-lite y solo se llega por URL directa (ver useRoute.js).
const TABS = [
  ['/rankings', 'rankings', 'Rankings'],
  ['/partidas', 'partidas', 'Partidas'],
  ['/rondas', 'rondas', 'Rondas'],
  ['/saldos', 'saldos', 'Saldos'],
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
