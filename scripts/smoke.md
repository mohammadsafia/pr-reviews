# End-to-end smoke test (manual, uses real Bitbucket + Claude)

1. `npm start` at repo root → open http://127.0.0.1:5175
2. Settings → enter Bitbucket email + API token → Save.
3. Home → paste a SMALL real PR URL, tick `review-code` only, Run Review.
4. Verify: live feed streams status + tool events; report renders grouped findings
   (or the explicit "no findings" state).
5. Tick one finding → Post to Bitbucket → confirm → check the comment appears
   inline on the PR in the browser.
6. Re-run the same PR: clone step should be fast (cache hit — "Preparing repository
   checkout…" completes in ~1s).
7. Failure path: put a wrong token in Settings, submit a run → the run view shows
   a 401 message pointing at Settings.
8. **Verify findings ON** (default): Home → paste a PR URL, select review skills,
   confirm "Verify findings" checkbox is checked, Run Review. After the run completes,
   inspect the report header: it should show a summary line like "N confirmed · M unverified".
   Any unverified finding in the list should display a "unverified" badge with a one-line
   reason explaining why verification failed.
9. **Verify findings OFF**: Home → paste the same (or different) PR URL, select review
   skills, uncheck "Verify findings", Run Review. After the run completes, the report
   should show a "verification skipped" note in the header. All findings should render
   without unverified badges; none should carry a verification badge or reason.
