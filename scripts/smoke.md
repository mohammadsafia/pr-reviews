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
