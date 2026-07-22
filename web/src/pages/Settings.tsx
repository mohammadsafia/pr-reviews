import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  addGithubSkillSource,
  clearRepoCache,
  getConfig,
  getSkills,
  putConfig,
  refreshSkillSource,
  removeSkillSource,
} from '../api.js'
import { isSkillRepoDir } from '../lib/skills.js'
import type { Config, SkillInfo } from '../types.js'

const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced (recommended)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable Opus' },
  { id: 'claude-fable-5', label: 'Claude Fable 5 — highest capability' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest / cheapest' },
] as const

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
          <Card.Title>GitHub</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 pt-0">
          <div className="flex flex-col gap-2">
            <Label htmlFor="gh-token">API token</Label>
            <Input
              id="gh-token"
              type="password"
              value={cfg.githubToken}
              onChange={(e) => set({ githubToken: e.target.value })}
              placeholder="*** means your saved token is kept"
            />
            <p className="text-muted-foreground text-xs">
              Fine-grained PAT with pull-request read/write on the repos you review.
            </p>
          </div>
        </Card.Content>
      </Card>

      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Skill sources</Card.Title>
        </Card.Header>
        <Card.Content className="pt-0">
          <SkillSources
            cfg={cfg}
            onAddLocal={(dir) => set({ skillDirs: [...cfg.skillDirs, dir] })}
            onReloadConfig={() =>
              getConfig()
                .then((fresh) => setCfg((prev) => (prev ? { ...prev, skillDirs: fresh.skillDirs } : fresh)))
                .catch(() => {})
            }
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
            {(() => {
              const isKnown = MODELS.some((m) => m.id === cfg.model)
              return (
                <>
                  <select
                    id="model"
                    value={isKnown ? cfg.model : 'custom'}
                    onChange={(e) =>
                      set({ model: e.target.value === 'custom' ? '' : e.target.value })
                    }
                    className="border-muted-200 bg-background hover:not-disabled:border-primary hover:not-disabled:ring-primary hover:not-disabled:ring focus-visible:ring-primary focus-visible:border-primary focus-visible:ring flex w-full rounded-md border p-3 text-sm shadow-xs outline-none"
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </select>
                  {!isKnown && (
                    <Input
                      aria-label="Custom model ID"
                      placeholder="e.g. claude-opus-4-8 or a dated snapshot"
                      value={cfg.model}
                      onChange={(e) => set({ model: e.target.value })}
                    />
                  )}
                </>
              )
            })()}
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
  const [provider, setProvider] = useState<'bitbucket' | 'github'>('bitbucket')
  const [ws, setWs] = useState('')
  const [repo, setRepo] = useState('')
  const [cleared, setCleared] = useState(false)
  const [clearError, setClearError] = useState('')

  const handleClear = () => {
    setClearError('')
    setCleared(false)
    clearRepoCache(provider, ws, repo).then((r) => {
      if (r.ok) {
        setCleared(true)
      } else {
        setClearError(r.error ?? 'Failed to clear cache')
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 border-t border-muted-200 pt-4">
      <p className="text-sm font-medium">Clear a cached repo</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          aria-label="Provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as 'bitbucket' | 'github')
            setCleared(false)
            setClearError('')
          }}
          className="border-muted-200 bg-background hover:not-disabled:border-primary hover:not-disabled:ring-primary hover:not-disabled:ring focus-visible:ring-primary focus-visible:border-primary focus-visible:ring shrink-0 rounded-md border p-3 text-sm shadow-xs outline-none sm:w-40"
        >
          <option value="bitbucket">Bitbucket</option>
          <option value="github">GitHub</option>
        </select>
        <Input
          placeholder="workspace"
          value={ws}
          onChange={(e) => {
            setWs(e.target.value)
            setCleared(false)
            setClearError('')
          }}
        />
        <Input
          placeholder="repo"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value)
            setCleared(false)
            setClearError('')
          }}
        />
        <Button variant="outline-destructive" disabled={!ws || !repo} onClick={handleClear}>
          Clear cache
        </Button>
      </div>
      {cleared && (
        <p className="text-muted-foreground text-xs">
          Cache cleared for {provider}/{ws}/{repo}.
        </p>
      )}
      {clearError && <p className="text-destructive text-xs">{clearError}</p>}
    </div>
  )
}

function SkillSources({
  cfg,
  onAddLocal,
  onReloadConfig,
}: {
  cfg: Config
  onAddLocal: (dir: string) => void
  onReloadConfig: () => void
}) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [skillsError, setSkillsError] = useState('')
  const [localDir, setLocalDir] = useState('')
  const [ghRepo, setGhRepo] = useState('')
  const [ghBusy, setGhBusy] = useState(false)
  const [ghMessage, setGhMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ dir: string; text: string } | null>(null)
  const [rowWarning, setRowWarning] = useState<{ dir: string; text: string } | null>(null)

  const reloadSkills = () =>
    getSkills()
      .then((s) => {
        setSkills(s)
        setSkillsError('')
      })
      .catch((e) => setSkillsError(e?.message ?? 'Failed to load skill counts'))

  useEffect(() => {
    reloadSkills()
  }, [])

  const countFor = (dir: string) => skills?.filter((s) => s.source === dir).length ?? 0

  const handleAddLocal = () => {
    const dir = localDir.trim()
    if (!dir || cfg.skillDirs.includes(dir)) return
    onAddLocal(dir)
    setLocalDir('')
  }

  const handleAddGithub = () => {
    const repo = ghRepo.trim()
    if (!repo || ghBusy) return
    setGhBusy(true)
    setGhMessage(null)
    addGithubSkillSource(repo).then((r) => {
      setGhBusy(false)
      if (r.error) {
        setGhMessage({ text: r.error, isError: true })
        return
      }
      setGhMessage({
        text: `Added ${r.skillCount} skill${r.skillCount === 1 ? '' : 's'} from ${r.dir}`,
        isError: false,
      })
      setGhRepo('')
      onReloadConfig()
      reloadSkills()
    })
  }

  const handleRemove = (dir: string) => {
    setRowBusy(dir)
    removeSkillSource(dir).then((r) => {
      setRowBusy(null)
      if (!r.ok) {
        setRowError({ dir, text: r.error ?? 'Failed to remove source' })
        setRowWarning(null)
        return
      }
      setRowError(null)
      if (r.warning) {
        setRowWarning({ dir, text: r.warning })
      } else {
        setRowWarning(null)
      }
      onReloadConfig()
      reloadSkills()
    })
  }

  const handleRefresh = (dir: string) => {
    setRowBusy(dir)
    refreshSkillSource(dir).then((r) => {
      setRowBusy(null)
      if (r.error) {
        setRowError({ dir, text: r.error })
        return
      }
      setRowError(null)
      reloadSkills()
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {cfg.skillDirs.length === 0 && (
          <p className="text-muted-foreground text-sm">No skill sources configured.</p>
        )}
        {cfg.skillDirs.map((dir) => {
          const repoBacked = isSkillRepoDir(dir, cfg.cacheDir)
          const count = countFor(dir)
          return (
            <div key={dir} className="border-muted-200 flex flex-col gap-1 rounded-md border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-family-mono min-w-0 flex-1 truncate text-sm" title={dir}>
                  {dir}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {skills ? `${count} skill${count === 1 ? '' : 's'}` : '…'}
                </span>
                {repoBacked && (
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-sm"
                    aria-label={`Refresh ${dir}`}
                    disabled={rowBusy === dir}
                    onClick={() => handleRefresh(dir)}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="icon-sm"
                  aria-label={`Remove ${dir}`}
                  disabled={rowBusy === dir}
                  onClick={() => handleRemove(dir)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {rowError?.dir === dir && <p className="text-destructive text-xs">{rowError.text}</p>}
              {rowWarning?.dir === dir && <p className="text-warning text-xs">{rowWarning.text}</p>}
            </div>
          )
        })}
        {skillsError && <p className="text-destructive text-xs">{skillsError}</p>}
      </div>

      <div className="border-muted-200 flex flex-col gap-2 border-t pt-4">
        <Label htmlFor="local-skill-dir">Add local directory</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="local-skill-dir"
            placeholder="/path/to/skills"
            value={localDir}
            onChange={(e) => setLocalDir(e.target.value)}
          />
          <Button
            type="button"
            variant="outline-muted"
            disabled={!localDir.trim()}
            onClick={handleAddLocal}
          >
            Add
          </Button>
        </div>
      </div>

      <div className="border-muted-200 flex flex-col gap-2 border-t pt-4">
        <Label htmlFor="github-skill-repo">Add from GitHub</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="github-skill-repo"
            placeholder="owner/repo or GitHub URL"
            value={ghRepo}
            onChange={(e) => setGhRepo(e.target.value)}
          />
          <Button
            type="button"
            variant="outline-muted"
            disabled={ghBusy || !ghRepo.trim()}
            onClick={handleAddGithub}
          >
            {ghBusy ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {ghMessage && (
          <p className={ghMessage.isError ? 'text-destructive text-xs' : 'text-success text-xs'}>
            {ghMessage.text}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noreferrer"
            className="hover:no-underline underline"
          >
            Find skills on skills.sh
          </a>
          {' — '}
          third-party skills are injected into the review agent's prompt; review sources before adding.
        </p>
      </div>
    </div>
  )
}
