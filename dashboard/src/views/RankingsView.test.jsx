import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { RankingsView } from './RankingsView'
import { getJSON } from '../api/client'

vi.mock('../api/client', () => ({
  getJSON: vi.fn(),
}))

afterEach(() => {
  vi.mocked(getJSON).mockReset()
})

const LEADERBOARD = [
  { gamertag: 'SsMecoboy', total_games: 20, overall_kd: 0.98, kda: 1.69, wins: 11, losses: 8, draws: 1, tier: 'Competitive', is_placement: false },
  { gamertag: 'Driest BR', total_games: 1, overall_kd: 1.2, kda: 1.95, wins: 0, losses: 1, draws: 0, tier: 'Placement', is_placement: true },
]

describe('RankingsView', () => {
  it('cada jugador lleva su tier corto junto a las partidas (para el celular) y el largo en su columna', async () => {
    vi.mocked(getJSON).mockImplementation(async (path) => (path.startsWith('/api/stats/leaderboard') ? LEADERBOARD : []))
    render(<RankingsView format="4v4" navigate={vi.fn()} />)

    const row = (await screen.findByText('SsMecoboy')).closest('tr')
    const inline = within(row).getByTitle('Competitive')
    expect(inline).toHaveTextContent('Comp')
    expect(inline).toHaveClass('show-sm')
    expect(within(row).getByText('Competitive')).toBeInTheDocument()
    expect(within(row).getByText('20 partidas')).toBeInTheDocument()

    const placement = screen.getByText('Driest BR').closest('tr')
    expect(within(placement).getByTitle('Placement')).toHaveTextContent('Nuevo')
    expect(within(placement).getByText('1 partida')).toBeInTheDocument()
  })
})
