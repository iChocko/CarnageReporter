// Cliente HTTP minimo para /api/*: timeout duro y un error tipado que
// conserva el status y el cuerpo de la respuesta para poder mostrarlo.

export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export async function getJSON(path, { signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(10000)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const res = await fetch(path, { signal: combinedSignal })

  if (!res.ok) {
    let body = null
    try { body = await res.json() } catch { /* respuesta sin JSON */ }
    throw new ApiError(res.status, body)
  }

  return res.json()
}
