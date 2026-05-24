# Sextant — App Store Listing

Everything required to fill out the App Store Connect form for the v1.0.0 submission. Character counts in `(N/limit)` parentheses. Pick from the alternatives where I've listed more than one.

---

## App Information

| Field | Value |
|---|---|
| **App Name** | Sextant `(7/30)` |
| **Bundle ID** | net.boringapps.sextant |
| **SKU** | sextant-ios |
| **Primary Language** | English (Australia) |
| **Primary Category** | Developer Tools |
| **Secondary Category** | Utilities |
| **Content Rights** | Does not contain, show, or access third-party content |
| **Age Rating** | 4+ (no objectionable content — answer "No" to every category) |
| **Copyright** | Copyright 2026 The IT Dept Pty Ltd (ABN 12 665 405 505) |
| **Trade Representative Contact** | (set to your contact in App Store Connect → Business) |

---

## Subtitle — pick one `(≤30)`

1. **Native Kubernetes client** `(24/30)`
2. **Kubernetes for iPhone & iPad** `(28/30)`
3. **kubectl in your pocket** `(22/30)`
4. **Private, native kubectl** `(23/30)`
5. **Your clusters, on your phone** `(28/30)`

Recommendation: **#2 "Kubernetes for iPhone & iPad"** — most searchable, most concrete, most clearly explains what the app does on first glance. #1 is the safe runner-up.

---

## Promotional Text `(≤170)` — editable without resubmission

Draft:

> Sextant is a native Kubernetes client for iPhone and iPad. Direct cluster connection — no Sextant cloud, no telemetry, no account required. `(143/170)`

Alternative (more launchy):

> New: Sextant 1.0. kubectl in your pocket — list pods, tail logs, exec into containers, manage Helm releases, port-forward. Direct, private, native. `(149/170)`

---

## Description `(≤4000)`

Draft (~1900 chars — there's headroom if you want to add anything):

```
Sextant is a Kubernetes client for iPhone and iPad — native, fast, and
designed for the way you actually use your phone: standing in the
kitchen, on the train, walking the dog and getting paged. No cloud,
no account, no proxy. Sextant talks directly from your device to your
cluster's API server. The credentials never leave your phone.

WHAT YOU CAN DO

• Browse every Kubernetes resource — pods, deployments, services,
  nodes, jobs, configmaps, ingresses, secrets, events, and any CRD
  your cluster exposes.
• Tail logs from any container, with timestamps and following.
• Exec into a pod and run a shell.
• Manage Helm releases — values, manifests, NOTES.txt, full revision
  history.
• Open port-forwards to pods and services. The forward runs locally
  on the phone; tap "Open in Safari" and you're on the internal
  endpoint.
• Switch between clusters and namespaces from the sidebar.
• Built for iPad: permanent sidebar in landscape, drawer in portrait,
  full Liquid Glass on iOS 26.

PRIVATE BY DESIGN

There is no Sextant backend. Your phone IS the kubectl. The HTTPS
request your cluster sees comes from your device's IP — Sextant never
sees it. Credentials (tokens, kubeconfig passwords, client
certificates) live exclusively in the iOS Keychain. No analytics, no
crash reporters, no telemetry of any kind. The full source code is
public so you can verify all of this yourself.

WORKS WITH

GKE, EKS, AKS, OpenShift, k3s, kind, microk8s, Rancher, on-prem
clusters — anything that speaks the Kubernetes API. Authenticate with
bearer tokens, basic auth, client certificates, or any kubeconfig you
can paste in. Custom CA bundles supported.

TRY BEFORE YOU CONNECT

Open the built-in demo cluster — a fully-functional Kubernetes
environment running entirely on your device — and play with every
feature before adding your real cluster.

OPEN SOURCE

Source published at github.com/boringapps/sextant (FSL-1.1-MIT). Read
the code, audit the network calls, verify the privacy claims. Issues
and pull requests welcome.
```

Word counts: ~310 words, 1900 chars. Plenty of room to expand if you want more sections (e.g. screenshots descriptions inline, FAQ, "made for SREs" angle).

---

## Keywords `(≤100, comma-separated, no spaces)`

Draft:

```
kubectl,kubernetes,k8s,helm,devops,sre,cluster,pod,oncall,deploy,kube,admin,client,logs,ops
```

`(91/100)` — well under, room to add more.

Notes:
- `k8s` is heavily searched and worth including verbatim.
- `kubectl` is the canonical CLI name; users will search this directly.
- Don't include "Sextant" (your app name is already indexed).
- Don't repeat words from the subtitle or app name.
- Plurals: Apple's algorithm usually handles "pods"/"pod" interchangeably; pick singular to save chars.

Optional additions if you trim something: `oncall,observability,yaml,exec,namespace,operator,crd`.

---

## URLs

| Field | Value |
|---|---|
| **Marketing URL** (optional) | https://boringapps.net/sextant |
| **Support URL** (required) | https://boringapps.net/sextant/support |
| **Privacy Policy URL** (required) | https://boringapps.net/sextant/privacy |

You need a real privacy policy live before submitting. See `marketing/privacy-policy.md` for a draft template.

---

## What's New (v1.0.0)

```
First public release of Sextant.

• Native Kubernetes browser for every built-in resource and CRD
• Helm release management
• Port forwards, logs streaming, pod exec
• iPad-optimised with permanent sidebar
• Built-in demo cluster — try every feature before you connect
• No backend, no telemetry, no account — credentials stay on device

Source: github.com/boringapps/sextant
```

(~410 chars; the field allows much more but short is fine for v1.)

---

## App Review Information

Notes to Apple's reviewer. **Important** — flag the demo cluster so they don't need real credentials:

```
Sextant is a Kubernetes management client. To review the app without
needing access to a real Kubernetes cluster, please use the built-in
Demo Cluster:

1. Launch the app
2. On the "Add a cluster" onboarding screen, tap "Use Demo Cluster"
3. The app opens against an in-memory, fully-functional Kubernetes
   environment seeded with realistic resources (pods, deployments,
   services, Helm releases, events, logs)
4. Every feature — browsing resources, viewing logs, port forwards,
   Helm release inspection, etc. — works against the demo cluster
   exactly as it does against a real one

No login credentials or test accounts are required.

About network traffic: when a user adds a real cluster, the app
connects directly from the device to that user-supplied Kubernetes
API server URL (typically a private or internal endpoint). There is
no Sextant backend or proxy.

About encryption: ITSAppUsesNonExemptEncryption=false. Sextant uses
only iOS standard TLS — no custom or proprietary cryptography.
```

| Field | Value |
|---|---|
| **Demo Account** | Not required (see notes) |
| **Contact First Name** | Nick |
| **Contact Last Name** | Pratley |
| **Contact Phone** | (your contact) |
| **Contact Email** | nick@npratley.net |
| **Notes** | (paste the block above) |

---

## Privacy — Data Collection (Nutrition Labels)

This is the big one for transparency. Sextant's answer to every category is **No data collected**.

Walk through each section in App Store Connect → App Privacy:

| Question | Answer | Reasoning |
|---|---|---|
| Do you or your third-party partners collect data from this app? | **No** | Nothing leaves the device except the user's own traffic to their own cluster API. |
| Are you tracking users? | **No** | No advertising/analytics SDKs. |

If App Store Connect insists you select something, the relevant clarifying truth is:

- **Identifiers**: Not collected.
- **Diagnostics**: Not collected (no crash reporter, no telemetry).
- **Usage Data**: Not collected.
- **User Content**: Not collected (cluster manifests/secrets are read from the user's own cluster and never sent to us).
- **Contact Info**: Not collected.

The transparency promise: every claim above is auditable in the public source code under `src/lib/` — see the README's "things you can check for yourself" section.

---

## Pricing & Availability

| Field | Value |
|---|---|
| **Price Tier** | (decide: free, paid one-off, or free w/ optional pro tier — see notes) |
| **Availability** | All territories where the App Store operates, *unless* there's a reason to limit |
| **Pre-Order** | Not used for v1.0 |

Pricing notes — questions worth answering before you ship:

1. **Free with no IAP** is the simplest story and aligns with the "we don't take your data either" positioning.
2. **One-off paid** (e.g. AU$14.99) signals "tool for professionals" and avoids the freemium grind.
3. **Free with optional paid tier** (e.g. multi-cluster sync, custom themes) leaves the door open but isn't necessary at v1.

No recommendation here — that's a business decision.

---

## Screenshots

See `marketing/screenshots/` for the captures and `marketing/screenshots-plan.md` for the order and intended caption per shot.

Apple's current requirements for a new submission:

| Device class | Resolution | Required? |
|---|---|---|
| iPhone 6.9" (iPhone 17 Pro Max / 16 Pro Max) | 1320 × 2868 px | **Yes** |
| iPad 13" (iPad Pro M5/M4 13") | 2064 × 2752 px | **Yes** (because supportsTablet=true) |
| Other iPhone / iPad sizes | — | Optional (Apple auto-scales from the required ones) |

Min 3, max 10 per device class. Recommendation: 5–7 per class is the sweet spot.

---

## Open Items / TODO Before Submit

- [ ] Privacy Policy live at https://boringapps.net/sextant/privacy
- [ ] Support page live at https://boringapps.net/sextant/support
- [ ] Decide pricing
- [ ] Decide whether to launch on Google Play simultaneously (Play has its own metadata file — happy to draft when you say go)
- [ ] App Store screenshots captured + reviewed
- [ ] Promo artwork / app preview videos (optional but high-impact)
- [ ] Final read of LICENSE and README links above
