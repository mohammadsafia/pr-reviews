import { createBrowserRouter } from 'react-router-dom'

import { AppLayout } from './layouts/AppLayout.js'
import { NewReview } from './pages/NewReview.js'
import { Runs } from './pages/Runs.js'
import { RunView } from './pages/RunView.js'
import { Settings } from './pages/Settings.js'
import { TestSkill } from './pages/TestSkill.js'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <NewReview /> },
      { path: 'runs', element: <Runs /> },
      { path: 'runs/:id', element: <RunView /> },
      { path: 'settings', element: <Settings /> },
      { path: 'skills/test', element: <TestSkill /> },
    ],
  },
])
