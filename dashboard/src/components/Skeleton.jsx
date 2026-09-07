const bars = (n) => Array.from({ length: n })

/** Placeholder de carga. `variant` elige la forma; ver index.css (.skel-*). */
export const Skeleton = ({ variant = 'lines', rows = 5 }) => {
  if (variant === 'table') {
    return (
      <div className="skel-table" aria-hidden="true">
        {bars(rows).map((_, i) => <div className="skel-row" key={i} />)}
      </div>
    )
  }
  if (variant === 'cards') {
    return (
      <div className="skel-cards" aria-hidden="true">
        {bars(rows).map((_, i) => <div className="skel-card" key={i} />)}
      </div>
    )
  }
  if (variant === 'hero') {
    return (
      <div className="skel-hero" aria-hidden="true">
        <div className="skel-bar wide" />
        <div className="skel-bar" />
        <div className="skel-bar" />
      </div>
    )
  }
  return (
    <div className="skel-lines" aria-hidden="true">
      {bars(rows).map((_, i) => <div className="skel-bar" key={i} />)}
    </div>
  )
}
