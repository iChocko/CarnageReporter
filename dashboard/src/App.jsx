import { lazy, Suspense, useState } from 'react'
import { useFormat } from './hooks/useFormat'
import { useRoute } from './hooks/useRoute'
import { Header } from './components/Header'
import { Tabs } from './components/Tabs'
import { ServerBanner } from './components/ServerBanner'
import { RankingsView } from './views/RankingsView'
import { PartidasView } from './views/PartidasView'
import { H2HView } from './views/H2HView'
import { PerfilView } from './views/PerfilView'
import { DISCORD_URL, GITHUB_URL, PAYPAL_URL } from './lib/links'

const StripePaymentModal = lazy(() =>
  import('./components/StripePaymentModal').then(m => ({ default: m.StripePaymentModal }))
)

const App = () => {
  const [format, setFormat] = useFormat()
  const route = useRoute()
  const [stripeOpen, setStripeOpen] = useState(false)
  const stripeEnabled = Boolean(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

  return (
    <div className="wrap">
      <ServerBanner />
      <Header format={format} onFormatChange={setFormat} />
      <Tabs view={route.view} navigate={route.navigate} />

      <section className="view">
        {route.view === 'rankings' && <RankingsView format={format} navigate={route.navigate} />}
        {route.view === 'partidas' && <PartidasView format={format} />}
        {route.view === 'h2h' && <H2HView format={format} />}
        {route.view === 'perfil' && (
          <PerfilView format={format} gamertag={route.param} navigate={route.navigate} />
        )}
      </section>

      <footer className="site">
        <span>Carnage Reporter · H3 MCC</span>
        <span>
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">Discord</a>
          {' · '}
          <a href={PAYPAL_URL} target="_blank" rel="noopener noreferrer">PayPal</a>
          {stripeEnabled && (
            <>
              {' · '}
              <button onClick={() => setStripeOpen(true)}>Apoyar el proyecto</button>
            </>
          )}
          {' · '}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
        </span>
      </footer>

      {stripeOpen && (
        <Suspense fallback={null}>
          <StripePaymentModal isOpen={stripeOpen} onClose={() => setStripeOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}

export default App
