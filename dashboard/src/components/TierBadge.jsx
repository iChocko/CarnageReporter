import { TIER_CLASS } from '../lib/format'

// Etiqueta corta para el celular, donde el tier va junto al nombre y no en su columna.
const TIER_SHORT = { 'Pro': 'Pro', 'Semi-Pro': 'Semi', 'Competitive': 'Comp', 'Amateur': 'Amat', 'Placement': 'Nuevo' }

export const TierBadge = ({ tier, short = false, className = '' }) => (
  <span className={['tier', TIER_CLASS[tier], className].filter(Boolean).join(' ')} title={short ? tier : undefined}>
    {short ? (TIER_SHORT[tier] ?? tier) : tier}
  </span>
)
