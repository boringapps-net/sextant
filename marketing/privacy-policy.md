# Sextant — Privacy Policy

**Template to publish at https://boringapps.net/apps/sextant/privacy.** Review and adjust before going live. Reflects the app's actual behaviour as of v1.0.0.

---

# Privacy Policy

**Effective Date:** [DATE OF PUBLICATION]
**Last Updated:** [DATE OF PUBLICATION]

This Privacy Policy describes how Sextant ("the app", "we", "us") handles information when you use it.

Sextant is published by **The IT Dept Pty Ltd** (ABN 12 665 405 505), a company registered in Australia, under the **BoringApps** project (boringapps.net).

## Summary

Sextant does not collect, transmit, or store any of your data on our servers. We do not have servers.

The app runs entirely on your device and connects only to the Kubernetes clusters that you explicitly configure. Your credentials never leave your device.

## What Sextant Stores On Your Device

- **Cluster connection metadata** (cluster name, server URL, namespace selection, UI preferences): stored in your device's standard app storage.
- **Cluster credentials** (bearer tokens, kubeconfig passwords, client certificates, custom CA bundles): stored in the iOS Keychain (or Android Keystore on Android). These never leave your device.

This data is removed when you uninstall the app.

## What Sextant Sends Over the Network

When you interact with one of your configured clusters, Sextant makes HTTPS requests directly from your device to that cluster's Kubernetes API server. The URL, the authentication credentials, and the request payload are all defined by your cluster configuration — not by us. We never see, intercept, or proxy this traffic.

The app makes no other network requests. There are no analytics requests, no crash report uploads, no licence checks, no update pings.

## What We Do Not Do

- We do not collect personally identifiable information.
- We do not use analytics or telemetry SDKs of any kind.
- We do not use third-party crash reporters.
- We do not track you across apps or websites.
- We do not sell, share, or process any data.
- We do not have user accounts.
- We do not run any backend service that the app talks to.

## Verifying These Claims

The Sextant source code is publicly available at **github.com/boringapps-net/sextant** under the Functional Source License (FSL-1.1-MIT). You — or anyone you trust to read code — can audit the entire app and verify that the statements in this policy are accurate. The README's "Why the source is here" section lists the specific files to look at.

## Children's Privacy

Sextant is a professional tool for software engineers and is not directed at children under 13. We do not knowingly collect any information from anyone.

## Third-Party Services

Sextant does not integrate with any third-party services. The only network destinations the app communicates with are the Kubernetes API server URLs that you yourself enter into the cluster configuration.

## Changes to This Policy

If we materially change how the app handles data, this page will be updated and the "Last Updated" date above will change. Because Sextant doesn't collect or transmit data today, any change in that direction would be a substantive one and would be communicated in the app's release notes.

## Contact

If you have questions about this policy or the app's behaviour, please contact:

**Nick Pratley**
The IT Dept Pty Ltd
Email: hello@boringapps.net
Web: https://boringapps.net/apps/sextant

---

## Notes (not part of the published policy)

- If you later add an opt-in feature that transmits anything (e.g. cluster sharing, multi-device sync, crash reports), this policy needs an update *before* the feature ships.
- Apple's App Privacy section in App Store Connect must match this policy. If you change one, change the other.
- If you ever add analytics behind a toggle, default it to OFF and require explicit user enable — that's the only stance consistent with the current positioning.
