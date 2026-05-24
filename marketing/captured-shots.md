# Captured Screenshots — v1.0.0 submission

What was actually shot, in the order it should appear in the App Store carousel, with the caption I'd recommend per shot. All files at App Store native resolution — no resize needed.

## iPhone (1320×2868) — 8 shots

`marketing/screenshots/iphone/`

| File | Caption suggestion | What it sells |
|---|---|---|
| `01-dashboard.png` | **Your cluster at a glance** | Tidy native landing — CPU/memory metrics, resource counts, quick actions. First-impression shot. |
| `02-pods-list.png` | **Browse every resource** | Mixed-namespace pod list with status dots, ages, restart counts. Bread-and-butter capability. |
| `03-pod-detail.png` | **Inspect anything in detail** | Logs/Shell/Restart actions, metadata, owner refs, labels, live CPU/memory. |
| `04-logs.png` | **Stream logs from anywhere** | Live indicator, auto-scroll, timestamps, filter — all visible. |
| `05-helm-list.png` | **Helm release management** | Mix of `deployed` and `failed` statuses, chart versions, revisions. |
| `06-helm-detail.png` | **Values, manifests, full history** | Tab bar (Overview/Values/Manifest/History/Notes) is the differentiator vs. generic k8s viewers. |
| `07-exec.png` | **Exec into a container** | Terminal with real command output, container + shell pickers, connection status. |
| `08-drawer.png` | **Multi-cluster, full resource taxonomy** | Drawer with cluster header, namespace pill, search, every category. |

Upload all 8 — Apple allows up to 10 per device class.

## iPad (2064×2752) — 5 shots

`marketing/screenshots/ipad/`

| File | Caption suggestion | What it sells |
|---|---|---|
| `01-dashboard.png` | **Built for iPad** | Permanent sidebar + dashboard side-by-side. Establishes the iPad-native story immediately. |
| `02-pods-table.png` | **Wide-mode resource tables** | Columns (name/namespace/status/restarts/age/node) make use of the width. |
| `03-pod-detail.png` | **Sidebar + detail in one view** | Workstation-class layout — context never collapses. |
| `04-helm-values.png` | **Helm release management** | Values tab with real YAML, tab picker, sidebar context. |
| `05-logs.png` | **Live logs, native scrolling** | Closes with utility — logs streaming, all controls visible. |

## Demo-data polish backlog

Noticed while shooting; not blockers for screenshots but worth fixing before next captures (or before App Store reviewers explore the demo themselves):

- [ ] **Pods all show `ready 0/1`** — the demo fixtures don't mark `containerStatuses[*].ready = true`, so every pod looks unhealthy in the list. Likely in `src/lib/k8s/demo/fixtures.ts`. Set ready=true and `restartCount=0` for the "happy" pods so screenshots don't suggest a broken cluster.
- [ ] **iPad table view shows `Completed` for every pod's Status** — same source, but the iPhone list view shows `Running` for the same pods. Suggests the table-mode status computation differs from the row-summary one. Worth a quick grep through `row-columns.ts` / `row-summaries.ts`.
- [ ] **Port-forwards are a no-op in demo mode** — flagged during capture; we skipped the port-forwards shot because of it. Either:
  - (a) Implement a simulated port-forward in the demo client (the "forward" becomes a local listener that returns a canned HTTP response) — would unlock the shot and let reviewers exercise the feature.
  - (b) Leave it as-is and document in the App Store reviewer notes that port-forwards require a real cluster.
- [ ] **Status-bar override on iPad shows a partial carrier string** (`9:41 ull Sun 24 May` — looks like "Full" is leaking through). The iPhone override read clean. Worth checking the iPad-specific `status_bar override` flags before any re-shoot.

None of these block the v1.0.0 submission with the current screenshots — the demo data quirks aren't visible enough to be deal-breakers and the captions guide the reader's eye to the right value props.

## Re-capture commands (if you ever need them)

```bash
# iPhone 17 Pro Max
xcrun simctl boot "iPhone 17 Pro Max"
xcrun simctl status_bar booted override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 --dataNetwork wifi
xcrun simctl install booted /tmp/sextant-sim/Sextant.app
xcrun simctl launch booted net.boringapps.sextant
# ... open dev launcher, demo, navigate, then for each screen:
xcrun simctl io booted screenshot marketing/screenshots/iphone/NN-name.png

# iPad Pro 13"
xcrun simctl shutdown "iPhone 17 Pro Max"
xcrun simctl boot "iPad Pro 13-inch (M5)"
# ...same status_bar / install / launch / capture flow
```

Build artifact lives at `/tmp/sextant-sim/Sextant.app` — produced by `eas build --profile simulator --platform ios --local --non-interactive` (eas.json profile added in this session). If you wipe `/tmp` you'll need to re-run that build.
