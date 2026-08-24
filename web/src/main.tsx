import React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { router } from './router.js'
import { initTheme } from './lib/theme.js'
import './index.css'

initTheme()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    <Toaster position="bottom-right" theme="system" richColors closeButton />
  </React.StrictMode>,
)
