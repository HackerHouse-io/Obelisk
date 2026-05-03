---
name: appium-driving
summary: Drive an iOS app via an Appium + XCUITest session. Capabilities, selectors, recipes.
---

# Role

You drive an iOS app through Appium's WebDriver protocol against the XCUITest backend. You assume:

- An Appium server is reachable at `http://127.0.0.1:${APPIUM_PORT}`.
- The xcuitest driver is installed (`appium driver install xcuitest` was run by Obelisk's Doctor).
- The simulator at `${UDID}` is booted and has the `.app` installed (the `ios-simulator-control` skill handled this).

## Capabilities

Required Appium capabilities (W3C `alwaysMatch`):

```json
{
  "platformName": "iOS",
  "appium:automationName": "XCUITest",
  "appium:udid": "${UDID}",
  "appium:wdaLocalPort": ${WDA_PORT},
  "appium:bundleId": "${BUNDLE_ID}",
  "appium:newCommandTimeout": 120,
  "appium:wdaStartupRetries": 2,
  "appium:wdaStartupRetryInterval": 20000,
  "appium:noReset": false
}
```

Selectors, in order of preference:
1. **Accessibility id** — `await driver.$('~Sign in')` (matches `accessibilityIdentifier`/`accessibilityLabel`). Fastest, most stable.
2. **iOS predicate** — `await driver.$('-ios predicate string:type == "XCUIElementTypeButton" AND name == "Continue"')`.
3. **Class chain** — `await driver.$('-ios class chain:**/XCUIElementTypeButton[`label == "Continue"`]')`.
4. **XPath** — last resort; slow on large hierarchies.

## Worked example

For:
- `APPIUM_PORT = 4723`
- `WDA_PORT = 8100`
- `UDID = "AA-BB-CC"`
- `BUNDLE_ID = "com.example.foo"`

```javascript
import { remote } from 'webdriverio';

const driver = await remote({
  protocol: 'http',
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  capabilities: {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': 'AA-BB-CC',
    'appium:wdaLocalPort': 8100,
    'appium:bundleId': 'com.example.foo',
    'appium:newCommandTimeout': 120,
  },
});

try {
  // Wait for the Welcome screen
  const signIn = await driver.$('~Sign in');
  await signIn.waitForDisplayed({ timeout: 8000 });
  await signIn.click();

  // Fill creds
  await (await driver.$('~email')).setValue('normal_user@example.com');
  await (await driver.$('~password')).setValue('correct horse battery staple');
  await (await driver.$('~Continue')).click();

  // Snapshot after the tap
  await driver.saveScreenshot('obelisk-evidence/${FLOW_ID}/after-tap.png');

  // Verify expected outcome
  const tabBar = await driver.$('-ios predicate string:type == "XCUIElementTypeTabBar"');
  await tabBar.waitForDisplayed({ timeout: 8000 });
} finally {
  await driver.deleteSession();
}
```

## Troubleshooting

- **`Could not start a new session. Response code 500. Message: An unknown server-side error occurred while processing the command.`** — WDA failed to launch. Wait 5s and retry once; if it still fails, emit `FLOW_INCONCLUSIVE` and ask Obelisk's Doctor to re-prebuild WDA.
- **`element not visible`** on a button you can plainly see** — XCUITest's `isDisplayed` returns false for elements outside the screen bounds even by 1px. Try `await element.scrollIntoView()` (works in WebdriverIO) or `await driver.execute('mobile: scroll', { direction: 'down' })`.
- **Stale element** after a navigation transition — re-fetch with `driver.$(...)` rather than reusing the old handle.
- **Session times out at 60s** — Increase `newCommandTimeout`. Default is too short for flows with network calls.
- **Multiple matches for the same selector** — XCUITest sometimes surfaces hidden duplicates; prefer accessibility id over predicates and use `[1]` indexing only as a fallback.
- **WDA port collision** — The pool guarantees unique ports per slot. If you see `EADDRINUSE`, another Obelisk run is on this slot — that's a bug in slot allocation; emit `FLOW_INCONCLUSIVE` with the message and Obelisk will release the slot.
