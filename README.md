# Sextant

A native Kubernetes client for iPhone, iPad, and Android.

[![Download on the App Store](https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg)](https://apps.apple.com/au/app/sextant/id6772725984)

- App Store: https://apps.apple.com/au/app/sextant/id6772725984
- Google Play: TODO

## What it is

Sextant talks directly to your Kubernetes clusters' API servers from
your phone. List and inspect pods, deployments, services, nodes, every
built-in resource and any CRD the cluster exposes. View Helm releases
(values, manifests, revision history). Open a port-forward to a pod or
service and reach it in Safari. Tail logs. Exec into a container.

It's a single-binary mobile app. There is no Sextant cloud, no Sextant
backend, no account to create. Your phone is the kubectl.

## Why the source is here

This repo exists so you can verify what Sextant does on your device.
Mobile apps that talk to production infrastructure are a reasonable
thing to be suspicious of, so the entire client is published as source
under [FSL-1.1-MIT](LICENSE).

Things you can check for yourself:

- **No analytics, no telemetry, no crash reporters.** The
  `package.json` lists every dependency; there is no Sentry, Firebase,
  Amplitude, PostHog, or equivalent. Nothing phones home.
- **Credentials never leave your device.** Tokens, kubeconfig
  passwords, and client certificates are written to the OS secure
  enclave via [`expo-secure-store`](https://docs.expo.dev/versions/v56.0.0/sdk/securestore/)
  (Keychain on iOS, Android Keystore on Android). See
  `src/lib/storage/clusters.ts`.
- **Traffic goes phone → API server, full stop.** There is no
  intermediate proxy. The HTTPS request your cluster sees comes from
  your device's IP. See `src/lib/k8s/client.ts`.
- **Cluster metadata (names, server URLs) lives in AsyncStorage** —
  not secret, but also not exfiltrated. Same `clusters.ts` file.

If you find anything in here that contradicts the above, please open
an issue.

## Demo mode

The app ships a built-in demo cluster: an in-memory Kubernetes API
implementation seeded with realistic fixtures (pods, deployments,
events, Helm releases, the lot). It exists so the App Store / Play
Store reviewers, and anyone curious before adding their own cluster,
have something to interact with that doesn't require a real
kubeconfig. Source is in `src/lib/k8s/demo/`.

## License

[FSL-1.1-MIT](LICENSE) — Functional Source License, MIT Future
License.

The short version: you may read, fork, modify, run, study, and
contribute back. You may **not** ship a competing app built on this
source — including, specifically, repackaging the binary and
publishing it to the App Store or Google Play. Two years after each
release, that version automatically becomes available under the MIT
License with no restrictions.

If you want to do something the license doesn't permit, get in touch.

## Building from source

For developers who want to run a local build against their own
clusters, or contribute a patch.

Requirements: Node 20+, pnpm, Xcode (for iOS), Android Studio (for
Android), an Expo dev client build.

```bash
pnpm install
pnpm expo prebuild
pnpm expo run:ios       # or run:android
```

The app uses [Expo Router](https://docs.expo.dev/versions/v56.0.0/)
56. File-based routes live under `src/app/`. The K8s client is in
`src/lib/k8s/`. UI primitives in `src/lib/ui/`. Contributor notes are
in `AGENTS.md`.
