import { useCallback, useEffect, useState } from 'react'

const KEY = 'cr:format'
const VALID = ['2v2', '4v4']
const DEFAULT_FORMAT = '2v2'

function safeGet() {
  try { return localStorage.getItem(KEY) } catch { return null }
}

function safeSet(value) {
  try { localStorage.setItem(KEY, value) } catch { /* almacenamiento no disponible */ }
}

function readFormat() {
  const fromUrl = new URLSearchParams(window.location.search).get('f')
  if (VALID.includes(fromUrl)) return fromUrl
  const fromStorage = safeGet()
  return VALID.includes(fromStorage) ? fromStorage : DEFAULT_FORMAT
}

/**
 * Formato (2v2/4v4) persistido en el query string (?f=4v4) y espejeado en
 * localStorage como respaldo. La URL es la fuente de verdad: al navegar
 * atrás/adelante el formato se vuelve a leer de ahí.
 */
export function useFormat() {
  const [format, setFormatState] = useState(readFormat)

  useEffect(() => {
    const onPopState = () => setFormatState(readFormat())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('f') !== format) {
      params.set('f', format)
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    }
    safeSet(format)
  }, [format])

  const setFormat = useCallback((next) => {
    if (VALID.includes(next)) setFormatState(next)
  }, [])

  return [format, setFormat]
}
