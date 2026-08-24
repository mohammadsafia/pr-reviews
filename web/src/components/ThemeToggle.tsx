import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getCurrentTheme, setTheme, type Theme } from '../lib/theme.js'

export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getCurrentTheme())
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="sm"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next)
        setThemeState(next)
      }}
      className="w-full justify-start gap-2"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="text-xs">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </Button>
  )
}
