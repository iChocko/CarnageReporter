import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartidasView } from './PartidasView'
import { getJSON } from '../api/client'

// PartidasView pasa por usePagedApi -> getJSON: controlamos las páginas de
// GET /api/stats/recent?format=..&limit=..&offset=.. directamente.
vi.mock('../api/client', () => ({
  getJSON: vi.fn(),
}))

afterEach(() => {
  vi.mocked(getJSON).mockReset()
})

// Partida 4v4 mínima con la forma de /api/stats/recent (jugadores anidados).
function game(i, endIso) {
  return {
    game_unique_id: `g${i}`, map_name: `Mapa ${i}`, game_type_name: 'HARDCORE CTF', format: '4v4',
    timestamp: endIso, duration: 600,
    players: [
      { gamertag: `A${i}`, team_id: 0, score: 3, kills: 10, deaths: 5, assists: 2 },
      { gamertag: `B${i}`, team_id: 1, score: 1, kills: 5, deaths: 10, assists: 1 },
    ],
  }
}

// Más reciente primero: la última termina 01:18 CDMX (07:18Z) y hay una cada 12 min hacia atrás.
const LAST_END = Date.parse('2026-09-23T07:18:00.000Z')
const history = n => Array.from({ length: n }, (_, i) => game(i, new Date(LAST_END - i * 12 * 60_000).toISOString()))

// Simula el endpoint: rebana el historial según limit/offset del path pedido.
function serve(all) {
  vi.mocked(getJSON).mockImplementation(async (path) => {
    const params = new URL(path, 'http://dashboard.test').searchParams
    const limit = Number(params.get('limit'))
    const offset = Number(params.get('offset'))
    return all.slice(offset, offset + limit)
  })
}

const MORE = { name: 'Cargar más partidas' }

describe('PartidasView', () => {
  it('pide el historial del formato por páginas y "Cargar más" trae la siguiente', async () => {
    // 55 partidas cada 12 min = una sola reta larga que la primera página (50) corta
    serve(history(55))
    render(<PartidasView format="4v4" />)

    expect(await screen.findByText('Mapa 0')).toBeInTheDocument()
    expect(screen.getByText('Customs y matchmaking 4v4 válidas · hora CDMX')).toBeInTheDocument()
    expect(getJSON).toHaveBeenCalledWith('/api/stats/recent?format=4v4&limit=50&offset=0', expect.anything())
    expect(screen.getByText('Mapa 49')).toBeInTheDocument()
    expect(screen.queryByText('Mapa 50')).not.toBeInTheDocument()
    // La reta sigue en la página siguiente: no se afirma su inicio ni su total
    expect(screen.getByText('… – 01:18 · 50+ partidas')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', MORE))

    expect(await screen.findByText('Mapa 54')).toBeInTheDocument()
    expect(getJSON).toHaveBeenLastCalledWith('/api/stats/recent?format=4v4&limit=50&offset=50', expect.anything())
    // La más vieja termina 20:30Z (54 × 12 min antes) y duró 10 min: empezó 14:20 CDMX
    expect(screen.getByText('14:20 – 01:18 · 55 partidas')).toBeInTheDocument()
    // La página vino incompleta: ya no hay más que cargar
    expect(screen.queryByRole('button', MORE)).not.toBeInTheDocument()
  })

  it('agrupa por reta: la sesión que cruza la medianoche queda bajo un solo día', async () => {
    // 16 partidas: la primera empieza 22:08 del martes 22 y la última termina 01:18 del miércoles 23
    serve(history(16))
    render(<PartidasView format="4v4" />)

    expect(await screen.findByText('Martes 22 de septiembre')).toBeInTheDocument()
    expect(screen.getByText('22:08 – 01:18 · 16 partidas')).toBeInTheDocument()
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.queryByRole('button', MORE)).not.toBeInTheDocument()
  })

  it('sin partidas del formato muestra el estado vacío con ese formato', async () => {
    serve([])
    render(<PartidasView format="4v4" />)

    expect(await screen.findByText(/Aún no hay partidas 4v4 registradas/)).toBeInTheDocument()
  })

  it('si falla la primera página muestra el error y "Reintentar" la vuelve a pedir', async () => {
    serve(history(3))
    vi.mocked(getJSON).mockRejectedValueOnce(new Error('HTTP 500'))
    render(<PartidasView format="2v2" />)

    expect(await screen.findByText('No se pudo cargar el historial de partidas.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))

    expect(await screen.findByText('Mapa 2')).toBeInTheDocument()
    expect(screen.getByText('Solo customs 2v2 válidas · hora CDMX')).toBeInTheDocument()
  })
})
