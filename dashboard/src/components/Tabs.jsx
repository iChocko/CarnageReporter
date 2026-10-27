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

// La pestaña del torneo solo aparece con un torneo activo; va primero y
// destacada (en celular ocupa su propio renglón arriba de la grilla 3 x 2).
export const Tabs = ({ view, navigate, torneoNombre }) => (
  <nav className="tabs" role="tablist" aria-label="Secciones">
    {torneoNombre && (
      <button className="tab tab-torneo" role="tab" aria-selected={view === 'torneo'} onClick={() => navigate('/torneo')}>
        🏆 {torneoNombre}
      </button>
    )}
    {TABS.map(([path, id, label]) => (
      <button key={id} className="tab" role="tab" aria-selected={view === id} onClick={() => navigate(path)}>
        {label}
      </button>
    ))}
  </nav>
)
