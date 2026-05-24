# Sextant — Screenshots Plan

The screenshots tell a story across the carousel. Each one needs to be readable as a thumbnail and convey one specific value prop, since most users only see the first 2–3 in the search results page.

Capturing against the built-in demo cluster, on:
- **iPhone 17 Pro Max simulator** → 1320 × 2868 px (App Store 6.9")
- **iPad Pro 13" (M5) simulator** → 2064 × 2752 px (App Store 13")

Files land in `marketing/screenshots/iphone/` and `marketing/screenshots/ipad/`, numbered to match the carousel order.

## Carousel order — iPhone (7 shots)

| # | Screen | Caption (overlay text — optional) | Story it tells |
|---|---|---|---|
| 1 | Cluster overview (counts of pods/deploys/svcs/nodes, version) | **Your cluster, at a glance** | First impression. Looks native, looks tidy, looks like a real tool. |
| 2 | Pod list with status dots, filter bar visible | **Every resource. Every CRD.** | Demonstrates the bread-and-butter list view. |
| 3 | Pod detail showing containers, image, restarts, conditions | **Inspect anything in detail** | Shows depth — not just a list. |
| 4 | Logs view tailing a container | **Stream logs from anywhere** | High-utility feature, instantly recognisable. |
| 5 | Helm releases list with status badges | **Helm releases — values, manifests, history** | Differentiator vs. generic k8s viewers. |
| 6 | Port-forwards screen with at least one active forward | **Port-forward from your phone** | Surprising/delightful capability. |
| 7 | Drawer (sidebar) open showing namespaces + clusters | **Multi-cluster, multi-namespace** | Closes the loop on "real engineer's tool". |

## Carousel order — iPad (5 shots)

iPad shots are wider and let you show the permanent sidebar + content together — fewer needed because each shot says more.

| # | Screen | Caption | Story |
|---|---|---|---|
| 1 | Overview with sidebar visible | **Built for iPad** | Sets up the iPad-native story immediately. |
| 2 | Resource list (e.g. pods) — table view with multiple columns | **Wide-mode resource tables** | Shows the table-vs-list responsive switch — a real iPad feature. |
| 3 | Resource detail beside a list | **Inspect alongside browsing** | Hits "this is a serious workstation tool" beat. |
| 4 | Helm release detail with tabs (Overview/Values/Manifest/History/Notes) | **Helm release management** | Big differentiator. |
| 5 | Logs streaming on a pod | **Live logs, native scrolling** | Closes with utility. |

## Capture method

The simulator framebuffer matches App Store target resolution exactly — no resize step needed.

```bash
# iPhone 17 Pro Max (1320 × 2868)
xcrun simctl io booted screenshot \
  marketing/screenshots/iphone/01-overview.png

# iPad Pro 13" — boot the M5 sim first, then:
xcrun simctl io booted screenshot \
  marketing/screenshots/ipad/01-overview.png
```

## Demo cluster prep before captures

Use the demo cluster (`Use Demo Cluster` on onboarding) for everything. Fixtures already include:

- `demo-app` namespace with the warp deployment + service + 3 pods
- `monitoring` namespace with kube-prometheus-stack pods
- Helm releases: warp (v2 deployed + v1 superseded), redis, kube-prometheus-stack, experimental-cache (failed)
- Recent events for visual life
- At least one port-forward in the demo state, or start one mid-capture (Source: warp service → port 80)

## Things to watch when capturing

- **Status bar**: clean it up with `xcrun simctl status_bar booted override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3` before captures.
- **Demo cluster name should read sensibly** (e.g. "Demo Cluster" not a hash).
- **Avoid empty states** — if the namespace filter is hiding rows, switch to "All namespaces".
- **Light mode vs dark mode**: Apple permits one carousel per locale. Pick whichever looks better — dark mode usually pops harder for developer tools.
- **No real cluster names/URLs** — demo only.
