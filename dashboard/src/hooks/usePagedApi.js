import { useEffect, useState } from 'react'
import { getJSON } from '../api/client'

/**
 * Lista paginada acumulativa: pide `${basePath}&limit=<pageSize>&offset=<n>`
 * página por página y las junta. `basePath` debe traer ya su query string
 * (p.ej. `/api/stats/recent?format=4v4`); si cambia, empieza de cero.
 *
 * Mismo patrón que useApi: el estado se DERIVA comparando contra la key
 * (basePath) del último resultado, y solo se llama setState dentro de los
 * callbacks async del fetch — nunca directo en el efecto.
 *
 * Devuelve { items, initialLoading, loading, error, hasMore, loadMore, retry }.
 */
export function usePagedApi(basePath, pageSize) {
  const [wanted, setWanted] = useState({ key: basePath, pages: 1 })
  const [result, setResult] = useState({ key: null, pages: [], error: null })

  const wantedPages = wanted.key === basePath ? wanted.pages : 1
  const pages = result.key === basePath ? result.pages : []
  const error = result.key === basePath ? result.error : null
  const nextOffset = pages.length * pageSize
  const loading = !error && pages.length < wantedPages

  useEffect(() => {
    if (!loading) return undefined
    const controller = new AbortController()

    getJSON(`${basePath}&limit=${pageSize}&offset=${nextOffset}`, { signal: controller.signal })
      .then(data => setResult(prev => {
        const prevPages = prev.key === basePath ? prev.pages : []
        if (prevPages.length * pageSize !== nextOffset) return prev // respuesta vieja
        return { key: basePath, pages: [...prevPages, data], error: null }
      }))
      .catch(err => {
        if (err.name === 'AbortError') return
        setResult(prev => ({ key: basePath, pages: prev.key === basePath ? prev.pages : [], error: err }))
      })

    return () => controller.abort()
  }, [basePath, pageSize, nextOffset, loading])

  const lastPage = pages[pages.length - 1]

  return {
    items: pages.flat(),
    initialLoading: loading && pages.length === 0,
    loading,
    error,
    hasMore: Boolean(lastPage) && lastPage.length === pageSize,
    loadMore: () => setWanted({ key: basePath, pages: pages.length + 1 }),
    // Reintenta la página que falló sin perder las ya cargadas.
    retry: () => setResult(prev => (prev.key === basePath ? { ...prev, error: null } : prev)),
  }
}
