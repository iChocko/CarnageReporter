import { useEffect, useRef, useState } from 'react'
import { getJSON, ApiError } from '../api/client'

/**
 * Como useApi (ver ese archivo para el porqué de derivar loading/data/error
 * de `result.key` en vez de setState directo en el efecto), pero manda
 * X-Admin-Key y avisa con `onUnauthorized` si el server responde 401 (clave
 * incorrecta o vencida) para que el panel /admin la limpie y pida de nuevo.
 *
 * Desactivado (data/error null, loading false) si falta `path` o `adminKey`.
 */
export function useAdminApi(path, adminKey, { onUnauthorized } = {}) {
  const [result, setResult] = useState(null)
  const [reloadTick, setReloadTick] = useState(0)
  const reqId = useRef(0)

  useEffect(() => {
    if (!path || !adminKey) return undefined

    const id = ++reqId.current
    const controller = new AbortController()

    getJSON(path, { signal: controller.signal, adminKey })
      .then(data => {
        if (id === reqId.current) setResult({ key: path, data, error: null })
      })
      .catch(error => {
        if (error.name === 'AbortError') return
        if (id === reqId.current) setResult({ key: path, data: null, error })
        if (error instanceof ApiError && error.status === 401) onUnauthorized?.()
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, adminKey, reloadTick])

  const active = Boolean(path) && Boolean(adminKey)
  const loading = active && (!result || result.key !== path)
  const data = result && result.key === path ? result.data : null
  const error = result && result.key === path ? result.error : null

  const reload = () => setReloadTick(t => t + 1)

  return { data, error, loading, reload }
}
