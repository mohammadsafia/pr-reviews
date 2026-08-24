import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { GitPullRequest, ListChecks, Menu, Plus, Settings as SettingsIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/ThemeToggle'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', end: true, label: 'New review', icon: Plus },
  { to: '/runs', end: false, label: 'Runs', icon: ListChecks },
  { to: '/settings', end: false, label: 'Settings', icon: SettingsIcon },
]

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ to, end, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-foreground before:bg-primary before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )
          }
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-6">
      <NavLink to="/" onClick={onNavigate} className="flex items-center gap-2 px-3 pt-1">
        <GitPullRequest className="text-primary h-5 w-5" />
        <span className="text-sm font-semibold tracking-tight">PR Reviewer</span>
      </NavLink>
      <NavItems onNavigate={onNavigate} />
      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </div>
  )
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  return (
    <div className="bg-background text-foreground flex min-h-screen">
      <aside className="border-sidebar-border bg-sidebar fixed inset-y-0 left-0 hidden w-60 border-r p-3 md:block">
        <SidebarContent />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        <header className="border-border flex items-center gap-3 border-b px-4 py-3 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <Sheet.Trigger asChild>
              <Button type="button" variant="ghost-muted" size="icon-sm" aria-label="Open navigation">
                <Menu className="h-5 w-5" />
              </Button>
            </Sheet.Trigger>
            <Sheet.Content>
              <Sheet.Title className="sr-only">Navigation</Sheet.Title>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
            </Sheet.Content>
          </Sheet>
          <span className="text-sm font-semibold">PR Reviewer</span>
        </header>

        <main
          key={location.pathname}
          className="animate-in fade-in-0 slide-in-from-bottom-1 mx-auto w-full max-w-5xl flex-1 px-6 py-8 duration-200"
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
