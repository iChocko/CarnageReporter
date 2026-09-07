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

/** fetch con timeout duro + header X-Admin-Key opcional (panel /admin). */
function rawFetch(path, { signal, adminKey, method = 'GET', body } = {}) {
  const timeoutSignal = AbortSignal.timeout(10000)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  const headers = {}
  if (adminKey) headers['X-Admin-Key'] = adminKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  return fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: combinedSignal,
  })
}

export async function getJSON(path, { signal, adminKey } = {}) {
  const res = await rawFetch(path, { signal, adminKey })

  if (!res.ok) {
    let body = null
    try { body = await res.json() } catch { /* respuesta sin JSON */ }
    throw new ApiError(res.status, body)
  }

  return res.json()
}

/** POST/DELETE admin (X-Admin-Key + body JSON opcional) -> JSON de respuesta. */
export async function adminFetch(path, { method = 'POST', adminKey, body, signal } = {}) {
  const res = await rawFetch(path, { signal, adminKey, method, body })

  if (!res.ok) {
    let respBody = null
    try { respBody = await res.json() } catch { /* respuesta sin JSON */ }
    throw new ApiError(res.status, respBody)
  }

  if (res.status === 204) return null
  try { return await res.json() } catch { return null }
}

/**
 * GET admin que devuelve un binario (el QR de WhatsApp). `null` en 204 (sin
 * QR pendiente); lanza ApiError en cualquier otro error.
 */
export async function adminGetBlob(path, { adminKey, signal } = {}) {
  const res = await rawFetch(path, { signal, adminKey })
  if (res.status === 204) return null
  if (!res.ok) throw new ApiError(res.status, null)
  return res.blob()
}
