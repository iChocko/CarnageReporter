import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { H2HView } from './H2HView'
import { getJSON } from '../api/client'

vi.mock('../api/client', () => ({
  getJSON: vi.fn(),
}))

afterEach(() => {
  vi.mocked(getJSON).mockReset()
})

const H2H = {
  p1: 'M4ST3RWARS', p2: 'BLACK ANGEL9607',
  rivals: { p1Wins: 1, p2Wins: 0, draws: 0, total: 1 },
  duo: { wins: 1, losses: 0, draws: 0, total: 1 },
  shared: [
    {
      game_unique_id: 'g1', map_name: 'Amplified', timestamp: '2026-09-23T07:18:00.000Z', same_team: true,
      p1: { result: 'W', kills: 39, deaths: 22, assists: 25 }, p2: { result: 'W', kills: 18, deaths: 29, assists: 23 },
    },
    {
      game_unique_id: 'g2', map_name: 'Construct', timestamp: '2026-09-23T04:09:00.000Z', same_team: false,
      p1: { result: 'W', kills: 18, deaths: 12, assists: 6 }, p2: { result: 'L', kills: 10, deaths: 14, assists: 6 },
    },
  ],
}

describe('H2HView', () => {
  it('las partidas compartidas llevan fecha y dupla/rivales bajo el mapa (celular) sin perder las columnas de pantalla grande', async () => {
    vi.mocked(getJSON).mockImplementation(async (path) => {
      if (path.startsWith('/api/stats/players')) return [{ gamertag: 'M4ST3RWARS' }, { gamertag: 'BLACK ANGEL9607' }]
      if (path.startsWith('/api/stats/h2h')) return H2H
      throw new Error(`ruta inesperada ${path}`)
    })
    render(<H2HView format="4v4" />)

    await screen.findAllByRole('option', { name: 'M4ST3RWARS' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Jugador 1' }), 'M4ST3RWARS')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Jugador 2' }), 'BLACK ANGEL9607')
    await userEvent.click(screen.getByRole('button', { name: 'Comparar' }))

    const row = (await screen.findByText('Amplified')).closest('tr')
    expect(within(row).getByLabelText('🤝 Dupla')).toHaveTextContent('🤝')
    expect(within(row).getByText('🤝 Dupla')).toBeInTheDocument()
    expect(within(row).getAllByText('23/09/2026 01:18', { exact: false })).toHaveLength(2)

    const rivals = screen.getByText('Construct').closest('tr')
    expect(within(rivals).getByLabelText('⚔️ Rivales')).toHaveTextContent('⚔️')
  })
})
