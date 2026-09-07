import { TIER_CLASS } from '../lib/format'

export const TierBadge = ({ tier }) => (
  <span className={`tier ${TIER_CLASS[tier] ?? ''}`}>{tier}</span>
)
