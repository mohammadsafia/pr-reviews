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
