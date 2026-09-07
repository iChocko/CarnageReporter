import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorState } from './ErrorState'

describe('ErrorState', () => {
  it('muestra el mensaje dado y llama a reload al hacer clic en Reintentar', async () => {
    const reload = vi.fn()
    const user = userEvent.setup()
    render(<ErrorState message="No se pudo cargar." reload={reload} />)

    expect(screen.getByText('No se pudo cargar.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('sin reload, no muestra el botón de Reintentar', () => {
    render(<ErrorState message="Algo falló." />)
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
  })

  it('sin message, usa el texto por defecto', () => {
    render(<ErrorState reload={() => {}} />)
    expect(screen.getByText('Algo salió mal al cargar los datos.')).toBeInTheDocument()
  })
})
