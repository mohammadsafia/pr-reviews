import { useEffect, useState } from 'react'
import { NewReview } from './screens/NewReview.js'
import { RunView } from './screens/RunView.js'
import { Settings } from './screens/Settings.js'

export type Route = { screen: 'new' } | { screen: 'run'; id: string } | { screen: 'settings' }

export function parseRoute(hash: string): Route {
  const run = /^#\/runs\/(.+)$/.exec(hash)
  if (run) return { screen: 'run', id: run[1] }
  if (hash === '#/settings') return { screen: 'settings' }
  return { screen: 'new' }
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute(window.location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return (
    <div className="app">
      <header>
        <a href="#/">PR Reviewer</a>
        <a href="#/settings">Settings</a>
      </header>
      {route.screen === 'new' && <NewReview />}
      {route.screen === 'run' && <RunView id={route.id} />}
      {route.screen === 'settings' && <Settings />}
    </div>
  )
}
