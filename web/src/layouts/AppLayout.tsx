import { NavLink, Outlet } from 'react-router-dom'

import { cn } from '@/lib/utils'

export function AppLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-muted-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <NavLink to="/" className="font-family-display text-xl italic">
            PR Reviewer
          </NavLink>
          <nav className="flex items-center gap-4 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                cn('text-muted-foreground hover:text-foreground', isActive && 'text-foreground font-medium')
              }
            >
              New review
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn('text-muted-foreground hover:text-foreground', isActive && 'text-foreground font-medium')
              }
            >
              Settings
            </NavLink>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Outlet />
      </div>
    </div>
  )
}
