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

10. **Idempotent comment posting**: 
    - Home → paste a real PR URL, select review skills, Run Review.
    - In the report, find a finding and click "Post to Bitbucket" → select that finding in the dialog → confirm and post.
    - Navigate to the PR in Bitbucket (or the browser's PR view): verify the comment appears inline and contains NO visible marker or hidden fingerprint text (it should read clean, as a normal comment).
    - Return to the tool and re-open the same PR's report (or re-run the same PR) → click "Post to Bitbucket" again → the confirm dialog should now label the previously posted finding as "Already posted" and exclude it from the list of findings available to post.
    - Navigate back to the PR and resolve the comment thread (mark as resolved or click the resolve button in your PR view).
    - Return to the tool and re-open the confirm dialog for posting → the resolved comment should now show as "Resolved" and be excluded from posting.
    - Click "Post" to submit any new findings (if any remain) → the result message should read "Posted N. Skipped M (X already posted, Y resolved)" (or similar, accounting for actual counts).

11. **Login-expiry recovery and retry-failed-skills**:
    - Invalidate your Claude authentication: either exit Claude Code (`exit` in the CLI) or temporarily set `ANTHROPIC_API_KEY=invalid` in your shell.
    - Home → paste a PR URL, select review skills, Run Review.
    - Confirm the login-expiry warning banner appears (in addition to the usual "Run failed" error): "Your Claude login appears to have expired — re-authenticate (run `/login` or restart with a valid `ANTHROPIC_API_KEY`), then retry." Both the banner and the standard failed-run error text/skill chips are expected together — don't report a false failure if you see the raw error too.
    - Below the banner, confirm a "Retry failed skills (N)" button appears (where N is the count of failed skills).
    - Re-authenticate: exit the tool, run `/login` (or restore your `ANTHROPIC_API_KEY`), and return to the run view.
    - Click "Retry failed skills (N)" → a new run should start with a fresh live feed, showing only the previously-failed skills being re-analyzed.
    - Wait for the retry run to complete; it should complete successfully (assuming your authentication is now valid).
    - Return to the first (failed) run's view → confirm its findings are still there and its banner still shows the expiry message; the retry run is a separate entry in the run history.
