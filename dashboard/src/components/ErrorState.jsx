export const ErrorState = ({ message, reload }) => (
  <div className="error-state">
    <p className="error-note">{message || 'Algo salió mal al cargar los datos.'}</p>
    {reload && <button className="btn-steel" onClick={reload}>Reintentar</button>}
  </div>
)
