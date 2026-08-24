import { useEffect, useState } from 'react'
import { AlertTriangle, Bot, Globe, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Tabs } from '@/components/ui/tabs'

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
import type { Config, ModelProfile, SkillInfo } from '../types.js'

const EMPTY_DRAFTS: Record<'claude' | 'cli' | 'openai', Record<string, string>> = {
  claude: { id: '', label: '', model: '' },
  cli: { id: '', label: '', command: '' },
  openai: { id: '', label: '', baseUrl: '', apiKey: '', model: '' },
}

export function Settings() {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [savedCfg, setSavedCfg] = useState<Config | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getConfig()
      .then((c) => {
        setCfg(c)
        setSavedCfg(c)
      })
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
  }

  const dirty = savedCfg !== null && JSON.stringify(cfg) !== JSON.stringify(savedCfg)

  const handleSave = () => {
    setError('')
    putConfig(cfg)
      .then(() => {
        setSavedCfg(cfg)
        toast.success('Settings saved')
      })
      .catch((e) => toast.error(e?.message ?? 'Failed to save settings'))
  }

  return (
    <div className="flex flex-col gap-6 pb-20">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connections, review models, skills, and storage.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <Alert.Title>Something went wrong</Alert.Title>
          <Alert.Description>{error}</Alert.Description>
        </Alert>
      )}

      <Tabs defaultValue="connections">
        <Tabs.List>
          <Tabs.Trigger value="connections">Connections</Tabs.Trigger>
          <Tabs.Trigger value="models">Models</Tabs.Trigger>
          <Tabs.Trigger value="skills">Skills</Tabs.Trigger>
          <Tabs.Trigger value="storage">Storage</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="connections" className="flex flex-col gap-6">
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
            <Label htmlFor="bb-workspace">Workspace</Label>
            <Input
              id="bb-workspace"
              placeholder="e.g. appswaveio"
              value={cfg.bitbucketWorkspace}
              onChange={(e) => set({ bitbucketWorkspace: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Used to find PRs awaiting your review — the workspace's most recently active repos are scanned.
            </p>
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
        </Tabs.Content>

        <Tabs.Content value="skills">
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
        </Tabs.Content>

        <Tabs.Content value="models">
      <Card shadow="sm">
        <Card.Header>
          <Card.Title>Review models</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4 pt-0">
          <ModelProfilesEditor cfg={cfg} set={set} />
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
        </Tabs.Content>

        <Tabs.Content value="storage">
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
        </Tabs.Content>
      </Tabs>

      {dirty && (
        <div className="animate-in slide-in-from-bottom-4 border-border bg-popover fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border py-2 pr-2 pl-5 shadow-deep">
          <span className="text-sm">Unsaved changes</span>
          <Button variant="ghost-muted" size="sm" className="rounded-full" onClick={() => setCfg(savedCfg)}>
            Discard
          </Button>
          <Button size="sm" className="rounded-full" onClick={handleSave}>
            Save
          </Button>
        </div>
      )}
    </div>
  )
}

function ModelProfilesEditor({ cfg, set }: { cfg: Config; set: (patch: Partial<Config>) => void }) {
  const [kind, setKind] = useState<'claude' | 'cli' | 'openai'>('claude')
  const [draft, setDraft] = useState<Record<string, string>>(EMPTY_DRAFTS.claude)
  const [rowError, setRowError] = useState('')

  const referenced = (id: string) => id === cfg.reviewProfile || id === cfg.verifyProfile

  const remove = (id: string) => {
    if (referenced(id)) {
      setRowError(`"${id}" is the default review or verify model — pick another default first.`)
      return
    }
    setRowError('')
    set({ modelProfiles: cfg.modelProfiles.filter((p) => p.id !== id) })
  }

  const add = () => {
    const id = draft.id.trim()
    if (!id || cfg.modelProfiles.some((p) => p.id === id)) {
      setRowError(id ? `A profile named "${id}" already exists.` : 'Profile id is required.')
      return
    }
    setRowError('')
    const label = draft.label.trim() || id
    const profile: ModelProfile =
      kind === 'claude'
        ? { id, label, kind, model: draft.model.trim() }
        : kind === 'cli'
          ? { id, label, kind, command: draft.command.trim().split(/\s+/)[0], args: draft.command.trim().split(/\s+/).slice(1) }
          : { id, label, kind, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey, model: draft.model.trim() }
    set({ modelProfiles: [...cfg.modelProfiles, profile] })
    setDraft({ ...EMPTY_DRAFTS[kind] })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {cfg.modelProfiles.map((p) => {
          const KindIcon = p.kind === 'claude' ? Bot : p.kind === 'cli' ? Terminal : Globe
          return (
          <div key={p.id} className="border-border flex items-center gap-2 rounded-md border px-3 py-2">
            <KindIcon className="text-muted-foreground h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{p.label}</span>{' '}
              <span className="text-muted-foreground font-family-mono text-xs">
                {p.id} · {p.kind}
                {p.kind === 'claude' ? ` · ${p.model}` : p.kind === 'openai' ? ` · ${p.model}` : ` · ${p.command}`}
              </span>
            </span>
            <Button
              type="button"
              variant="ghost-destructive"
              size="icon-sm"
              aria-label={`Remove profile ${p.id}`}
              onClick={() => remove(p.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          )
        })}
        {rowError && <p className="text-destructive text-xs">{rowError}</p>}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-col gap-2 sm:w-52 sm:shrink-0">
          <Label>Default review model</Label>
          <Select value={cfg.reviewProfile} onValueChange={(v) => set({ reviewProfile: v })}>
            <Select.Trigger aria-label="Default review model">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {cfg.modelProfiles.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  {p.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
        <div className="flex flex-col gap-2 sm:w-52 sm:shrink-0">
          <Label>Verify model</Label>
          <Select value={cfg.verifyProfile} onValueChange={(v) => set({ verifyProfile: v })}>
            <Select.Trigger aria-label="Verify model">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {cfg.modelProfiles.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  {p.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      </div>

      <div className="border-muted-200 flex flex-col gap-2 border-t pt-4">
        <Label>Add profile</Label>
        <div className="flex gap-2">
          {(['claude', 'cli', 'openai'] as const).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={kind === k ? 'default' : 'outline-muted'}
              onClick={() => {
                setKind(k)
                setDraft({ ...EMPTY_DRAFTS[k] })
              }}
            >
              {k}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="id (slug)" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          <Input placeholder="label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </div>
        {kind === 'claude' && (
          <Input placeholder="model id, e.g. claude-sonnet-5" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        )}
        {kind === 'cli' && (
          <>
            <Input
              placeholder="command line, e.g. codex exec --sandbox read-only --cd {cwd} -"
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              {'{cwd}'} is replaced with the checkout path; {'{prompt}'} with the prompt (omitted → prompt on stdin). Include the CLI's own read-only/sandbox flags — the tool cannot inject them.
            </p>
          </>
        )}
        {kind === 'openai' && (
          <div className="flex flex-col gap-2">
            <Input placeholder="base URL, e.g. https://api.moonshot.ai/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            <Input type="password" placeholder="API key" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            <Input placeholder="model, e.g. kimi-k2" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </div>
        )}
        <Button type="button" variant="outline-muted" className="w-fit" onClick={add}>
          Add profile
        </Button>
      </div>
    </div>
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
        <div className="flex flex-col gap-2 sm:w-40 sm:shrink-0">
          <Label>Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v as 'bitbucket' | 'github')
              setCleared(false)
              setClearError('')
            }}
          >
            <Select.Trigger aria-label="Provider">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="bitbucket">Bitbucket</Select.Item>
              <Select.Item value="github">GitHub</Select.Item>
            </Select.Content>
          </Select>
        </div>
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
