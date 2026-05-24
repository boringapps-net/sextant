# Sextant — Pre-submission TODO

Pre-flight checklist organised by what blocks what. `[?]` means I don't know the current state — confirm or strike through as you go.

## Blocks submission (must have)

### Production build

- [ ] Production EAS build: `eas build --profile production --platform ios`
  (the simulator profile we used for screenshots doesn't go to the store)
- [ ] Test the production build on a real device — at minimum an iPhone,
  ideally also iPad. Things to verify against your *real* cluster: TLS
  auth, port-forwards (don't work in demo), exec, logs streaming over
  slow networks.
- [ ] `eas submit --platform ios` to upload to App Store Connect, or use
  Transporter manually.

### App Store Connect app record

- [?] App created in App Store Connect (bundle ID `net.boringapps.sextant`
  registered, app entry exists)
- [ ] All fields from `marketing/app-store-listing.md` pasted in
- [ ] Screenshots from `marketing/store/iphone/` and `marketing/store/ipad/`
  uploaded to the matching device classes
- [ ] Pricing tier set (planned: AU$14.99 / US$9.99, tier 10)
- [ ] Territory availability (default: all)
- [ ] Age rating questionnaire — answer No to every category → 4+
- [ ] Encryption export compliance — `ITSAppUsesNonExemptEncryption=false`
  is already in app.json; just confirm "no" in the form
- [ ] Privacy nutrition labels — "No data collected" across the board
- [ ] App Review Information — paste the demo-cluster reviewer notes from
  `app-store-listing.md`

### Hosted pages live

- [ ] Privacy policy live at `boringapps.net/sextant/privacy`
  (template in `marketing/privacy-policy.md`)
- [ ] Support page live at `boringapps.net/sextant/support` — at minimum
  a page with an email contact
- [ ] (Optional) marketing page at `boringapps.net/sextant`

### Legal / account

- [?] Apple Developer Program enrolled and paid (assumed yes — EAS creds
  are set up)
- [?] Tax + banking info in App Store Connect → Agreements/Tax/Banking
  (W-8BEN-E for AU Pty Ltd selling in US)
- [?] Paid Apps agreement signed (separate from the free apps agreement;
  can't sell without it)

## Should fix before submit (quality)

- [ ] **Demo-data fixes** from `captured-shots.md`:
  - Pod fixtures showing `ready 0/1` — set `ready=true` on the happy-path
    pods so reviewers don't conclude the app shows everything as unhealthy
  - iPad table view showing `Completed` for Pods that should read `Running`
  - Port-forwards: either implement a fake-it forward for demo mode, or
    document the limitation in reviewer notes (currently called out in
    the notes — enough for review, but real users of the demo will notice)
- [ ] Smoke-test on actually slow network conditions (Network Link
  Conditioner) — logs streaming and exec on Edge/3G is where mobile k8s
  tools tend to fall over

## Optional but high-impact

- [ ] App preview video (1 per device class, 15–30s) — most apps don't have
  them; if you do, you stand out. A 20s walkthrough of the demo cluster
  would be plenty.
- [ ] Decide Google Play timing — if simultaneous launch, need to draft Play
  metadata (different sizes/format) and create a Play Console account
  ($25 one-time). If iOS-only first, defer.
- [ ] Launch comms plan — HN, /r/kubernetes, /r/devops, Twitter. Worth
  writing a "why I built this" post on boringapps.net to anchor the
  launch.
- [ ] Crash reporting decision — currently *zero* crash reporting, which
  is consistent with the privacy story but means you're blind to v1
  crashes. Any change here requires updating the privacy policy +
  nutrition labels first.

## Available to delegate

Things I can knock out without you blocking:

1. **Fix the demo-data backlog** (pod ready/status — ~15 min in `fixtures.ts`)
2. **Draft a Google Play listing** parallel to the iOS one
3. **Draft a "why I built this" launch blog post** for the website
4. **Write a 30s app-preview video storyboard** (frame-by-frame demo cluster
   walkthrough)
