import { useEffect, useState } from 'react'
import { clearRepoCache, getConfig, putConfig } from '../api.js'
import type { Config } from '../types.js'

export function Settings() {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getConfig()
      .then(setCfg)
      .catch((e) => setError(e?.message ?? 'Failed to load settings'))
  }, [])
  if (error) return <p className="error">{error}</p>
  if (!cfg) return <p>Loading…</p>

  const set = (patch: Partial<Config>) => {
    setCfg({ ...cfg, ...patch })
    setSaved(false)
  }

  const handleSave = () => {
    setError('')
    putConfig(cfg)
      .then(() => setSaved(true))
      .catch((e) => setError(e?.message ?? 'Failed to save'))
  }

  return (
    <main>
      <h2>Settings</h2>
      <label>
        Bitbucket email
        <input value={cfg.bitbucketEmail} onChange={(e) => set({ bitbucketEmail: e.target.value })} />
      </label>
      <label>
        Bitbucket API token
        <input
          type="password"
          value={cfg.bitbucketToken}
          onChange={(e) => set({ bitbucketToken: e.target.value })}
          placeholder="*** means unchanged"
        />
      </label>
      <label>
        Skill directories (one per line)
        <textarea
          value={cfg.skillDirs.join('\n')}
          onChange={(e) => set({ skillDirs: e.target.value.split('\n').filter(Boolean) })}
        />
      </label>
      <label>
        Model
        <input value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
      </label>
      <label>
        Diff warning threshold (changed lines)
        <input
          type="number"
          value={cfg.diffWarnLines}
          onChange={(e) => set({ diffWarnLines: Number(e.target.value) })}
        />
      </label>
      <label>
        Clone cache location
        <input value={cfg.cacheDir} onChange={(e) => set({ cacheDir: e.target.value })} />
      </label>
      <button onClick={handleSave}>
        Save
      </button>
      {saved && <p>✅ Saved.</p>}

      <h3>Clear a cached repo</h3>
      <ClearCache />
    </main>
  )
}

function ClearCache() {
  const [ws, setWs] = useState('')
  const [repo, setRepo] = useState('')
  const [cleared, setCleared] = useState(false)
  return (
    <div>
      <input placeholder="workspace" value={ws} onChange={(e) => setWs(e.target.value)} />
      <input placeholder="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <button
        disabled={!ws || !repo}
        onClick={() => clearRepoCache(ws, repo).then(() => setCleared(true))}
      >
        Clear cache
      </button>
      {cleared && <p>✅ Cache cleared for {ws}/{repo}.</p>}
    </div>
  )
}
