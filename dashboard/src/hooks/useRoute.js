import { useCallback, useEffect, useState } from 'react'

// Vistas implementadas. /admin es admin-lite: solo se llega por URL directa,
// nunca aparece en Tabs (ver components/Tabs.jsx). Cualquier ruta que no
// esté aquí cae a rankings.
const KNOWN_VIEWS = ['rankings', 'partidas', 'h2h', 'perfil', 'rondas', 'saldos', 'roster', 'admin']

function parsePath(pathname) {
  const [seg, param] = pathname.split('/').filter(Boolean)
  if (seg === 'perfil') return { view: 'perfil', param: param ? decodeURIComponent(param) : null }
  if (KNOWN_VIEWS.includes(seg)) return { view: seg, param: null }
  return { view: 'rankings', param: null }
}

/** Router minimo basado en History API: sin react-router, ~25 líneas. */
export function useRoute() {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setRoute(parsePath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Conserva el query string actual (formato ?f=) al navegar entre vistas.
  const navigate = useCallback((path) => {
    const url = path + window.location.search
    window.history.pushState(null, '', url)
    setRoute(parsePath(path))
  }, [])

  return { ...route, navigate }
}
