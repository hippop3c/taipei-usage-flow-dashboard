# Monthly Access ETL

Use the root-level `update-dashboard.ps1` wrapper for normal operation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-dashboard.ps1 -Period 2026-07 -DriveRoot 'E:\'
```

Pipeline order:

1. `run-etl-fast.ps1` invokes the unchanged 32-bit `read-accdb-fast.ps1` worker with `-Period yyyy/MM`, writes `work/months/YYYY-MM/usage`, and calls `merge-data.mjs`.
2. `merge-data.mjs` writes `public/months/YYYY-MM/usage.json`, updates the append-only station/month manifest in `public/subsidy-data.js`, and writes its audit under `work/audits`.
3. `run-od-etl.ps1` invokes the unchanged 32-bit `read-od-fast.ps1` worker and writes `work/months/YYYY-MM/od`.
4. `build-flow-files.mjs` rebuilds only `public/months/YYYY-MM/flows` and keeps its audit under `work/audits`.

The Access workers use borrow time, not payment time. Public usage rows remain `[stationIndex, 0, count]` with only the count metric. Non-weekend holidays are versioned in `holidays.json`.
