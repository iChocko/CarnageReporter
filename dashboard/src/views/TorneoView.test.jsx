import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TorneoView } from './TorneoView'
import fixture from '../test/torneo.fixture.json'

// fixture generado con server/utils/torneo.js (config real de Leyendas
// Oxidadas 2.0): serie 2 Tomm 2-0 Shine, con un G1 reiniciado, un DC de
// SsMecoboy y una cuenta alterna ("Legit PC") jugando con Tomm.
const api = (over = {}) => ({ data: fixture, error: null, loading: false, reload: vi.fn(), ...over })

describe('TorneoView', () => {
  it('tabla: Tomm arriba con la serie ganada y el roster al tocarlo', async () => {
    render(<TorneoView torneo={api()} />)
    expect(screen.getByRole('heading', { name: 'Leyendas Oxidadas 2.0' })).toBeInTheDocument()
    expect(screen.getByText(/1\/10 series/)).toBeInTheDocument()

    const rows = screen.getAllByRole('row')
    expect(within(rows[1]).getByText('Tomm')).toBeInTheDocument()
    expect(within(rows[1]).getByText('+2')).toBeInTheDocument()
    // Tabla tipo Mundial: PJ 1, PG 1, PE 0, PP 0, 3 pts
    const cells = within(rows[1]).getAllByRole('cell').map(c => c.textContent)
    expect(cells.slice(2, 6)).toEqual(['1', '1', '0', '0'])
    expect(cells[cells.length - 1]).toBe('3')
    expect(within(rows[2]).getAllByRole('cell').map(c => c.textContent).slice(-1)[0]).toBe('0')

    await userEvent.click(within(rows[1]).getByText('Tomm'))
    expect(screen.getByText('Mast3wars')).toBeInTheDocument()
    expect(screen.getAllByText('Legit PC').length).toBeGreaterThan(0)
    expect(screen.getAllByText('no registrado').length).toBeGreaterThan(0)
  })

  it('series: las 10 del póster y el detalle con reinicio y DC', async () => {
    render(<TorneoView torneo={api()} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Series' }))

    expect(screen.getAllByText('Pendiente')).toHaveLength(9)
    expect(screen.getByText('Terminada')).toBeInTheDocument()
    expect(screen.getAllByText('Onslaught').length).toBeGreaterThan(0)

    // G1 de la serie 2 (Guardian): ganó Tomm en la repetición
    const g1 = screen.getByRole('button', { name: 'Game 1: Guardian Oddball, gana Tomm' })
    await userEvent.click(g1)
    expect(screen.getByText(/reiniciada/)).toBeInTheDocument()

    const g2 = screen.getByRole('button', { name: 'Game 2: Narrows Slayer, gana Tomm' })
    await userEvent.click(g2)
    expect(screen.getByText('DC')).toBeInTheDocument()
  })

  it('jugadores: filtra por equipo y ordena por columna', async () => {
    render(<TorneoView torneo={api()} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Jugadores' }))
    await userEvent.click(screen.getByRole('button', { name: 'Shine' }))
    const names = screen.getAllByRole('row').slice(1).map(r => r.querySelector('.cell-name').textContent)
    expect(names).toEqual(expect.arrayContaining(['Shine', 'Shady', 'Mecoboy', 'Hydracoin']))
    expect(names).not.toContain('Tomm')

    await userEvent.click(screen.getByRole('columnheader', { name: 'PJ' }))
    expect(screen.getByRole('columnheader', { name: 'PJ' })).toHaveAttribute('aria-sort', 'descending')
  })

  it('sin torneo activo (404) muestra estado vacío; otro error, reintentar', () => {
    const { unmount } = render(<TorneoView torneo={api({ data: null, error: { status: 404 } })} />)
    expect(screen.getByText('No hay torneo activo.')).toBeInTheDocument()
    unmount()
    render(<TorneoView torneo={api({ data: null, error: { status: 500 } })} />)
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
  })
})
