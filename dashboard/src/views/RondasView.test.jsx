import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RondasView } from './RondasView'
import { getJSON } from '../api/client'

// Mock del cliente HTTP: RondasView solo pasa por useApi -> getJSON, asi que
// controlamos la respuesta de GET /api/stats/rondas directamente.
vi.mock('../api/client', () => ({
  getJSON: vi.fn(),
}))

afterEach(() => {
  vi.mocked(getJSON).mockReset()
})

// Fixture realista con la forma de summarizeSession (server/utils/sessions.js):
// un enfrentamiento con una ronda cerrada 2-0 y una ronda en curso 1-0.
const liveSessionResponse = {
  session: {
    live: true,
    dateLabel: 'SÁB 12 JUL',
    startedAt: '2026-07-12T02:00:00.000Z',
    lastGameAt: '2026-07-12T03:10:00.000Z',
    gamesCount: 3,
    enfrentamientos: [
      {
        sides: [['Alfa', 'Beta'], ['Cyto', 'Delta']],
        rondasWon: [1, 0],
        rondas: [
          {
            winnerSide: 0,
            games: [
              { gameId: 'g1', map: 'Guardian', scores: [50, 40], winnerSide: 0, timestamp: '2026-07-12T02:00:00.000Z', kind: 'game' },
              { gameId: 'g2', map: 'Sandtrap', scores: [50, 35], winnerSide: 0, timestamp: '2026-07-12T02:20:00.000Z', kind: 'game' },
            ],
          },
        ],
        current: {
          wins: [1, 0],
          games: [
            { gameId: 'g3', map: 'Narrows', scores: [50, 45], winnerSide: 0, timestamp: '2026-07-12T03:10:00.000Z', kind: 'game' },
          ],
        },
      },
    ],
    cuenta: [],
  },
  rondaMxn: 25,
}

const noop = () => {}

describe('RondasView', () => {
  it('sin sesión, muestra el estado vacío', async () => {
    vi.mocked(getJSON).mockResolvedValue({ session: null, rondaMxn: 25 })

    render(<RondasView navigate={noop} />)

    expect(await screen.findByText('Sin retas registradas.')).toBeInTheDocument()
    expect(screen.queryByText('🟢 En vivo')).not.toBeInTheDocument()
  })

  it('con sesión en vivo, muestra la insignia "En vivo" y los bloques/puntos Bo3 esperados', async () => {
    vi.mocked(getJSON).mockResolvedValue(liveSessionResponse)

    const { container } = render(<RondasView navigate={noop} />)

    expect(await screen.findByText('🟢 En vivo')).toBeInTheDocument()
    expect(screen.queryByText('🔴 Terminada')).not.toBeInTheDocument()
    expect(screen.getByText('Alfa + Beta')).toBeInTheDocument()
    expect(screen.getByText('Cyto + Delta')).toBeInTheDocument()

    // 1 ronda cerrada + 1 ronda en curso = 2 bloques de ronda.
    const rondaBlocks = container.querySelectorAll('.ronda-block')
    expect(rondaBlocks).toHaveLength(2)

    // Cada bloque tiene dos BoDots (izquierda/derecha) de 2 puntos c/u = 4 por bloque.
    const dots = container.querySelectorAll('.bo-dot')
    expect(dots).toHaveLength(2 * 4)

    // 2 partidas de la ronda cerrada + 1 de la ronda en curso = 3 tarjetas de partida.
    const gameRows = container.querySelectorAll('.ronda-game')
    expect(gameRows).toHaveLength(3)
  })
})
