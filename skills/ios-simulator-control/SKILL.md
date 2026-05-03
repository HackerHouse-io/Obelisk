---
name: ios-simulator-control
summary: Boot, install on, erase, and record an iOS Simulator via xcrun simctl.
---

# Role

You operate an iOS Simulator through `xcrun simctl`. You're typically called with a pre-allocated UDID; do NOT create new simulators inside a run — Obelisk's pool manager owns lifecycle.

## Capabilities

- Boot a simulator: `xcrun simctl boot ${UDID}` (idempotent — succeeds if already booted).
- Install an app bundle: `xcrun simctl install ${UDID} ${APP_PATH}`.
- Launch an app: `xcrun simctl launch ${UDID} ${BUNDLE_ID}`.
- Erase data without shutting down: `xcrun simctl erase ${UDID}` (called between flows by Obelisk; you don't usually invoke this).
- Stream device logs: `xcrun simctl spawn ${UDID} log stream --level=info --style=compact > obelisk-evidence/${FLOW_ID}/syslog.txt &` (background; kill on cleanup).
- Record video: `xcrun simctl io ${UDID} recordVideo --codec=h264 obelisk-evidence/${FLOW_ID}/recording.mp4 &` (background; SIGINT to finalise).
- Take a screenshot: `xcrun simctl io ${UDID} screenshot obelisk-evidence/${FLOW_ID}/<label>.png`.

## Worked example

For the inputs:
- `UDID = "AA-BB-CC"`
- `APP_PATH = "build/Debug-iphonesimulator/Foo.app"`
- `BUNDLE_ID = "com.example.foo"`
- `FLOW_ID = "a1b2c3d4e5f60718"`

```sh
mkdir -p obelisk-evidence/${FLOW_ID}

# 1. Boot (idempotent)
xcrun simctl boot ${UDID} || true

# 2. Reset app state, install, launch
xcrun simctl uninstall ${UDID} ${BUNDLE_ID} || true
xcrun simctl install ${UDID} ${APP_PATH}

# 3. Start recording + log stream (capture PIDs to clean up later)
xcrun simctl io ${UDID} recordVideo --codec=h264 obelisk-evidence/${FLOW_ID}/recording.mp4 &
REC_PID=$!
xcrun simctl spawn ${UDID} log stream --level=info > obelisk-evidence/${FLOW_ID}/syslog.txt &
LOG_PID=$!

# 4. (Hand off to Appium for the actual flow)

# 5. Cleanup — SIGINT recordVideo so it finalises the .mp4 cleanly.
kill -INT ${REC_PID}
kill ${LOG_PID}
wait ${REC_PID} ${LOG_PID} 2>/dev/null || true
```

## Troubleshooting

- **`Unable to boot device in current state: Booted`** — Benign. The `|| true` in the boot step swallows it.
- **`Simulator is in an unknown state`** — Run `xcrun simctl shutdown ${UDID}` then re-boot. If the issue persists, ask the user to run "Doctor → Run setup" again to re-clone the slot.
- **Recording produces a 0-byte file** — You exited with `kill -9` instead of `kill -INT`. Use SIGINT (`-2`) so simctl flushes the muxer.
- **Log stream is empty** — Some apps buffer their logs; use `--level=debug` or scope the predicate: `--predicate 'subsystem == "com.example.foo"'`.
- **Device says "Storage Almost Full"** — The pool slot has accumulated app data across runs. Tell Obelisk via `FLOW_INCONCLUSIVE` and ask the user to run `xcrun simctl erase ${UDID}` (Obelisk usually does this between runs; if it didn't, surface it).
