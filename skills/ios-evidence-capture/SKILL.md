---
name: ios-evidence-capture
summary: Capture screen recordings, screenshots, and syslog excerpts; format the BEGIN_IOS_QA_FINDINGS block.
---

# Role

You collect the evidence Obelisk needs to file a credible iOS QA issue: a screen recording, key screenshots, and a relevant slice of device log. You assemble the structured findings JSON the orchestrator will parse.

## Capabilities

- Save evidence under `obelisk-evidence/${FLOW_ID}/` in the worktree. Obelisk picks artifacts up from these paths automatically.
- Recording, syslog, and screenshots are produced by the `ios-simulator-control` skill; this skill formats them.
- Trim syslog to the 60s window around the failure. Long log dumps obscure the signal.
- Compute a confidence score (see scoring guide below).
- Emit exactly one `BEGIN_IOS_QA_FINDINGS` block per run.

## Worked example

After driving the flow with `appium-driving` and stopping the recording with `ios-simulator-control`, you have:

```
obelisk-evidence/${FLOW_ID}/
├── recording.mp4        # full session
├── before-tap.png       # screenshot before the failing action
├── after-tap.png        # screenshot of the broken state
└── syslog.txt           # full simctl log stream output
```

You then:

1. Trim syslog to the relevant window:
   ```sh
   tail -n 200 obelisk-evidence/${FLOW_ID}/syslog.txt | grep -E '(Error|fault|app-name)' > obelisk-evidence/${FLOW_ID}/syslog.excerpt.txt
   ```
2. Fill in the JSON exactly:
   ```
   BEGIN_IOS_QA_FINDINGS
   [
     {
       "flow_id": "${FLOW_ID}",
       "status": "failed",
       "symptom": "Tapping Continue spins forever after valid creds",
       "severity": "P1",
       "repro": "1. Launch. 2. Sign in. 3. Enter creds. 4. Tap Continue. → spinner > 30s.",
       "likely_area": "Auth/SignInViewModel.swift",
       "confidence": 0.88,
       "evidence": {
         "recording_path": "obelisk-evidence/${FLOW_ID}/recording.mp4",
         "screenshots": [
           "obelisk-evidence/${FLOW_ID}/before-tap.png",
           "obelisk-evidence/${FLOW_ID}/after-tap.png"
         ],
         "device_log_excerpt": "<paste 5-15 lines from syslog.excerpt.txt>",
         "syslog_excerpt": "<paste relevant AppDelegate/system errors>"
       }
     }
   ]
   END_IOS_QA_FINDINGS
   ```

### Confidence scoring

Start at 0.5 and adjust:
- **+0.2** Recording shows the symptom clearly.
- **+0.1** A screenshot captures the broken state.
- **+0.1** Syslog or device log contains a relevant error.
- **+0.1** You can name a specific likely_area (file/component).
- **−0.2** The symptom only appeared once across retries.
- **−0.2** The symptom matches a known warning in `qa/non-bugs.md`.

Floor at 0.0, cap at 1.0. Obelisk drops findings below 0.7.

## Troubleshooting

- **Recording is missing** — You SIGKILLed the recordVideo process. Use SIGINT and `wait`. Without a recording, do NOT file — emit `FLOW_INCONCLUSIVE` instead.
- **Screenshots are blank/black** — A common XCUITest bug when the simulator is partially backgrounded. Boot fully and re-take with `xcrun simctl io ${UDID} screenshot`.
- **Syslog excerpt is empty** — Use `--predicate` with the bundle id when starting the stream: `--predicate 'process == "Foo" OR subsystem == "com.example.foo"'`.
- **JSON parse error** in Obelisk logs — Likely a stray comment or trailing comma; the parser is strict JSON. Re-emit clean.
- **You found multiple bugs in one flow** — File the most severe one. Obelisk dispatches one flow per run, and the registry doesn't carry a 1-to-many issue map.
