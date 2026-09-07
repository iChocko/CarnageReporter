export const EmptyState = ({ children }) => (
  <div className="empty-state">
    <div className="big">🎮</div>
    {children || 'Aún no hay partidas registradas. ¡Jueguen la primera custom 2v2!'}
  </div>
)
