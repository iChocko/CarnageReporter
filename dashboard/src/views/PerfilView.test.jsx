import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PerfilView } from './PerfilView'
import { getJSON } from '../api/client'

vi.mock('../api/client', () => ({
  getJSON: vi.fn(),
}))

afterEach(() => {
  vi.mocked(getJSON).mockReset()
})

const PLAYERS = [
  { gamertag: 'M4ST3RWARS', total_games: 14 },
  { gamertag: 'SsMecoboy', total_games: 20 },
  { gamertag: 'Zeuz Zee', total_games: 25 },
]

const PROFILE = {
  gamertag: 'Zeuz Zee', games: 2, wins: 1, losses: 1, draws: 0, kills: 55,
  kd: 1.5, kda: 2.4, bestSpree: 7,
  history: [
    { game_unique_id: 'g1', map_name: 'Amplified', timestamp: '2026-09-23T07:18:00.000Z', result: 'W', kills: 37, deaths: 24, assists: 23, kd: 1.54 },
    { game_unique_id: 'g2', map_name: 'The Pit', timestamp: '2026-09-23T07:04:00.000Z', result: 'L', kills: 18, deaths: 26, assists: 23, kd: 0.69 },
  ],
}

function serve() {
  vi.mocked(getJSON).mockImplementation(async (path) => {
    if (path.startsWith('/api/stats/players')) return PLAYERS
    if (path.startsWith('/api/stats/player/')) return PROFILE
    throw new Error(`ruta inesperada ${path}`)
  })
}

const chip = name => screen.queryByRole('button', { name })

describe('PerfilView', () => {
  it('sin perfil abierto muestra a todos los jugadores', async () => {
    serve()
    render(<PerfilView format="4v4" gamertag={undefined} navigate={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'M4ST3RWARS' })).toBeInTheDocument()
    expect(chip('Zeuz Zee')).toBeInTheDocument()
  })

  it('con un perfil abierto pliega la lista (en el celular empujaba el perfil hacia abajo) y la despliega a pedido', async () => {
    serve()
    render(<PerfilView format="4v4" gamertag="Zeuz Zee" navigate={vi.fn()} />)

    const toggle = await screen.findByRole('button', { name: 'Ver los 3 jugadores' })
    expect(chip('M4ST3RWARS')).not.toBeInTheDocument()

    await userEvent.click(toggle)
    expect(chip('M4ST3RWARS')).toBeInTheDocument()
    expect(chip('Ver los 3 jugadores')).not.toBeInTheDocument()
  })

  it('al buscar muestra las coincidencias aunque haya un perfil abierto', async () => {
    serve()
    const navigate = vi.fn()
    render(<PerfilView format="4v4" gamertag="Zeuz Zee" navigate={navigate} />)

    await screen.findByRole('button', { name: 'Ver los 3 jugadores' })
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar jugador por gamertag' }), 's')

    expect(chip('M4ST3RWARS')).toBeInTheDocument()
    expect(chip('SsMecoboy')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled() // dos coincidencias: no salta solo a ninguna
  })

  it('el historial trae la fecha bajo el mapa y el resultado en versión larga y corta', async () => {
    serve()
    render(<PerfilView format="4v4" gamertag="Zeuz Zee" navigate={vi.fn()} />)

    expect(await screen.findByText('Amplified')).toBeInTheDocument()
    // Columna Fecha (pantalla grande) + renglón bajo el mapa (celular)
    expect(screen.getAllByText('23/09/2026 01:18')).toHaveLength(2)
    expect(screen.getByText('Victoria')).toBeInTheDocument()
    expect(screen.getByText('V')).toBeInTheDocument()
    expect(screen.getByText('Derrota')).toBeInTheDocument()
    expect(screen.getByText('D')).toBeInTheDocument()
  })
})
