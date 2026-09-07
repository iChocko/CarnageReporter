// Matchers de jest-dom (toBeInTheDocument, etc.) para todos los tests RTL.
import '@testing-library/jest-dom/vitest'

// No usamos `test.globals` de vitest (preferimos imports explicitos en cada
// test, ver eslint.config.js), asi que el auto-cleanup de RTL -que depende
// de un `afterEach` global- no se activa solo: lo enganchamos a mano.
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
