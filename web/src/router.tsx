import { createBrowserRouter } from 'react-router-dom'

import { AppLayout } from './layouts/AppLayout.js'
import { NewReview } from './pages/NewReview.js'
import { RunView } from './pages/RunView.js'
import { Settings } from './pages/Settings.js'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <NewReview /> },
      { path: 'runs/:id', element: <RunView /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
])
