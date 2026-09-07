import { useEffect, useState } from 'react'

/**
 * Se re-evalúa en vivo con matchMedia (en vez de escuchar `resize`).
 * El valor para la query actual se lee directo de matchMedia() durante el
 * render (lectura pura, sin setState) hasta que el efecto se registra;
 * de ahí en adelante lo actualiza el listener 'change'.
 */
export function useMediaQuery(query) {
  const [state, setState] = useState(() => ({ query, matches: window.matchMedia(query).matches }))

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setState({ query, matches: mql.matches })
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return state.query === query ? state.matches : window.matchMedia(query).matches
}
