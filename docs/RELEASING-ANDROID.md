# Releasing Sextant to Google Play

CI builds a signed `.aab` with **EAS local builds** (no Expo cloud, no remote
credentials) and uploads it to the Play **internal testing** track via
`.github/workflows/android-playstore.yml`.

## Trigger

- **Manual:** Actions → *Android – Play Store* → Run workflow (pick a track).
- **Tag:** push a `v*.*.*` tag.

## What the workflow does

1. `pnpm install`, installs `eas-cli`.
2. Reads `android.package` from `app.json` and stamps a monotonic `versionCode`
   (`appVersionSource` is `local`, so EAS takes the value from app config).
3. Writes `credentials.json` + the keystore from secrets (local credentials).
4. `eas build --platform android --profile production --local` produces a signed
   `.aab` on the runner — nothing is sent to Expo's build servers.
5. Uploads the `.aab` to Google Play with the service-account JSON.

> `eas build --local` still authenticates the CLI with `EXPO_TOKEN`. That only
> identifies the project — no source is uploaded and no cloud build minutes are
> used. All signing material stays in the runner.

## Required secrets

| Name | What |
| --- | --- |
| `EXPO_TOKEN` | Expo access token (Account → Settings → Access tokens) |
| `ANDROID_KEYSTORE_BASE64` | base64 of the upload keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play service-account JSON (raw) |

No repo variable is needed — the package id (`net.boringapps.sextant`) is read
from `app.json`. See the workspace-level `STORE_AUTOMATION.md` for how to
generate these and the `gh` commands to upload them.

## Local builds

`credentials.example.json` documents the shape of `credentials.json`. Drop a
real keystore at `credentials/upload-keystore.jks`, fill in
`credentials.json`, then run:

```bash
eas build --platform android --profile production --local --output sextant.aab
```

Both `credentials.json` and `credentials/` are gitignored.

## First run

The app must already exist in the Play Console and you must have accepted the
developer agreement. Google requires the **first** bundle for a brand-new app to
be uploaded manually once; after that the workflow can publish on every run.
