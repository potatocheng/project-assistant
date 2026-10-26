# Structured QA round commands

Only the root agent runs real provider requests. All new round scripts preserve the previous 18 evaluation files and old reports.

Before live work:

1. Review `memory-qa-structured-preregistration-draft.json`, set `registeredAt` and create `memory-qa-structured-preregistration.json` with `wx`.
2. Freeze all production and new evaluation files, then run `node scripts/verify-memory-qa-structured.mjs`. This records 11 commands in a new regression artifact without overwriting old round evidence.
3. Validate options and fingerprints with `--no-api-dry-run`. It opens no proxy, starts no host and needs no provider key.

## Fixed confirmed-memory diagnostic, at most one pair

Baseline arm, actual preserved old binary:

```powershell
node scripts/evaluate-memory-qa-structured-live.mjs --split development --judge-mode separated --output-tag qa-structured-diag-baseline --baseline docs/memory-public-live-qa-targeted-dev-v4-results.json --diagnostic-arm baseline --frozen-memory-run docs/memory-public-live-qa-targeted-dev-v4-results.json --binary .local-data/qa-structured-baseline-uqSaud/bin/pm-host.exe --production-source-root .local-data/qa-structured-baseline-uqSaud --max-requests 1200 --max-tokens 6000000 --workers 3
```

Candidate arm uses the same confirmed memory and compares both newly executed outputs:

```powershell
node scripts/evaluate-memory-qa-structured-live.mjs --split development --judge-mode separated --output-tag qa-structured-diag-candidate --baseline docs/memory-public-live-qa-structured-diag-baseline-results.json --prior-run docs/memory-public-live-qa-structured-diag-baseline-results.json --diagnostic-arm candidate --frozen-memory-run docs/memory-public-live-qa-targeted-dev-v4-results.json --max-requests 1200 --max-tokens 6000000 --workers 3
```

Verify each arm with `verify-memory-qa-structured-results.mjs REPORT`. Both arms consume the shared development budget. The baseline has 40 actual QA entries and no judge calls; the candidate runs all 60 unchanged-criteria separated judge calls. This diagnostic cannot open the full100 gate. Actual supplied packs may differ: `compareActualPacks` reports the difference without claiming a true frozen-pack causal test.

## Fresh full-pipeline development, at most three attempts

```powershell
node scripts/evaluate-memory-qa-structured-live.mjs --split development --judge-mode separated --output-tag qa-structured-dev --baseline docs/memory-public-live-qa-targeted-dev-v4-results.json --prior-run docs/memory-public-live-qa-structured-diag-candidate-results.json --max-requests 1200 --max-tokens 6000000 --workers 3
node scripts/verify-memory-qa-structured-results.mjs docs/memory-public-live-qa-structured-dev-results.json
node scripts/check-memory-qa-structured-development.mjs docs/memory-public-live-qa-structured-dev-results.json docs/memory-public-live-qa-structured-dev-integrity.json docs/memory-qa-structured-regressions.json docs/memory-public-live-qa-structured-dev-gate.json
```

Every later attempt must chain its immediate previous run with `--prior-run`, including all failed runs and diagnostics. Interrupted runs require explicit `--resume` on the original workspace; never reuse a fresh tag.

## Full100 only after every development gate passes

```powershell
node scripts/evaluate-memory-qa-structured-live.mjs --split all --judge-mode separated --output-tag qa-structured-full --baseline docs/memory-public-live-qa-efficient-full-results.json --require-gate docs/memory-public-live-qa-structured-dev-gate.json --max-requests 2000 --max-tokens 12000000 --workers 3
node scripts/verify-memory-qa-structured-results.mjs docs/memory-public-live-qa-structured-full-results.json
```

## Reporting

```powershell
node scripts/report-memory-qa-structured.mjs --diagnostic-baseline docs/memory-public-live-qa-structured-diag-baseline-results.json --diagnostic-candidate docs/memory-public-live-qa-structured-diag-candidate-results.json --dev docs/memory-public-live-qa-structured-dev-results.json --gate docs/memory-public-live-qa-structured-dev-gate.json
```

Add `--full REPORT` only when it actually ran. Current and historical original grades, same-call paired grades, source retention/retrieval/answer funnel, actual producer packs, unknown decisions, protocol failures and request/token fees are retained separately. The complete metric JSON includes every prior run in the verified budget ledger. Automatic judge labels and trace decisions are provisional and are not new human annotations.
