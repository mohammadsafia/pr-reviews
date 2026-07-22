import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

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

  if (error && !cfg) {
    return (
      <main>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Couldn't load settings</Alert.Title>
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      </main>
    )
  }
  if (!cfg) return <p className="text-muted-foreground text-sm">Loading…</p>

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
    <main className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-family-display text-3xl">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Configure the Bitbucket connection, skills, review engine, and cache.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Couldn't save settings</Alert.Title>
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      )}

      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Bitbucket</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 pt-0">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bb-email">Email</Label>
            <Input
              id="bb-email"
              value={cfg.bitbucketEmail}
              onChange={(e) => set({ bitbucketEmail: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bb-token">API token</Label>
            <Input
              id="bb-token"
              type="password"
              value={cfg.bitbucketToken}
              onChange={(e) => set({ bitbucketToken: e.target.value })}
              placeholder="***"
            />
            <p className="text-muted-foreground text-xs">*** means your saved token is kept</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Clone protocol</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={cfg.cloneProtocol === 'ssh' ? 'default' : 'outline-muted'}
                onClick={() => set({ cloneProtocol: 'ssh' })}
              >
                SSH (recommended)
              </Button>
              <Button
                type="button"
                variant={cfg.cloneProtocol === 'https' ? 'default' : 'outline-muted'}
                onClick={() => set({ cloneProtocol: 'https' })}
              >
                HTTPS (uses API token)
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              SSH requires a key configured for bitbucket.org on this machine.
            </p>
          </div>
        </Card.Content>
      </Card>

      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Skills</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-2 pt-0">
          <Label htmlFor="skill-dirs">Skill directories (one per line)</Label>
          <Textarea
            id="skill-dirs"
            className="font-family-mono text-sm"
            value={cfg.skillDirs.join('\n')}
            onChange={(e) => set({ skillDirs: e.target.value.split('\n').filter(Boolean) })}
          />
        </Card.Content>
      </Card>

      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Review engine</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 pt-0">
          <div className="flex flex-col gap-2">
            <Label htmlFor="model">Model</Label>
            <Input id="model" value={cfg.model} onChange={(e) => set({ model: e.target.value })} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="diff-warn">Diff warning threshold (changed lines)</Label>
            <Input
              id="diff-warn"
              type="number"
              value={cfg.diffWarnLines}
              onChange={(e) => set({ diffWarnLines: Number(e.target.value) })}
            />
          </div>
        </Card.Content>
      </Card>

      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Storage</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 pt-0">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cache-dir">Clone cache location</Label>
            <Input
              id="cache-dir"
              value={cfg.cacheDir}
              onChange={(e) => set({ cacheDir: e.target.value })}
            />
          </div>
          <ClearCache />
        </Card.Content>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave}>Save changes</Button>
        {saved && <p className="text-success text-sm">Saved.</p>}
      </div>
    </main>
  )
}

function ClearCache() {
  const [ws, setWs] = useState('')
  const [repo, setRepo] = useState('')
  const [cleared, setCleared] = useState(false)
  return (
    <div className="flex flex-col gap-2 border-t border-muted-200 pt-4">
      <p className="text-sm font-medium">Clear a cached repo</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          placeholder="workspace"
          value={ws}
          onChange={(e) => {
            setWs(e.target.value)
            setCleared(false)
          }}
        />
        <Input
          placeholder="repo"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value)
            setCleared(false)
          }}
        />
        <Button
          variant="outline-destructive"
          disabled={!ws || !repo}
          onClick={() => clearRepoCache(ws, repo).then(() => setCleared(true))}
        >
          Clear cache
        </Button>
      </div>
      {cleared && (
        <p className="text-muted-foreground text-xs">
          Cache cleared for {ws}/{repo}.
        </p>
      )}
    </div>
  )
}
