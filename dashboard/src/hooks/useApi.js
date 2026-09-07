import { useEffect, useRef, useState } from 'react'
import { getJSON } from '../api/client'

/**
 * Trae `path` con getJSON y devuelve { data, error, loading, reload }.
 *
 * loading/data/error se DERIVAN comparando `path` contra la key del último
 * resultado ya resuelto (result.key) en vez de despachar setState al vuelo
 * dentro del efecto — así no dispara el warning de react-hooks
 * "set-state-in-effect" por cascada de renders, y el efecto solo llama a
 * setState dentro de los callbacks async del fetch (que sí está permitido).
 *
 * `path` en null/undefined desactiva el fetch (data/error quedan en null,
 * loading en false) — útil para fetches condicionados a una selección.
 * `deps` son dependencias extra del efecto (además de path); se reenvían
 * tal cual a useEffect, así que deben venir ya en un array estable.
 */
export function useApi(path, deps = []) {
  const [result, setResult] = useState(null) // { key, data, error }
  const [reloadTick, setReloadTick] = useState(0)
  const reqId = useRef(0)

  useEffect(() => {
    if (!path) return undefined

    const id = ++reqId.current
    const controller = new AbortController()

    getJSON(path, { signal: controller.signal })
      .then(data => {
        if (id === reqId.current) setResult({ key: path, data, error: null })
      })
      .catch(error => {
        if (error.name === 'AbortError') return
        if (id === reqId.current) setResult({ key: path, data: null, error })
      })

    return () => controller.abort()
    // `deps` son dependencias extra provistas por quien llama al hook (como
    // el propio useEffect nativo); no hay forma de que exhaustive-deps las
    // verifique de forma estática porque su tamaño/contenido es dinámico.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadTick, ...deps])

  const loading = Boolean(path) && (!result || result.key !== path)
  const data = result && result.key === path ? result.data : null
  const error = result && result.key === path ? result.error : null

  const reload = () => setReloadTick(t => t + 1)

  return { data, error, loading, reload }
}
