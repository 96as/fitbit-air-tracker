# iPhone app (`mobile/`) — build, install, and how alarms work

The iPhone app is a **standalone** Expo (React Native) app: prayer times,
sleep watching, and alarms all run on the phone. No server needs to be up at
night. The `server/` and `web/` workspaces remain for the browser client and
the future AI-agent surface, sharing the same engine (`packages/core`).

## 1. Install on your own iPhone (free Apple ID, no App Store)

Requirements: a Mac with **Xcode 26** (iOS 26 SDK), your iPhone on **iOS 26+**,
a USB cable (or same Wi-Fi after first install), Node ≥ 22.5.

```bash
# one-time
git clone <repo> && cd fitbit-air-tracker
npm install
open -a Xcode         # Xcode ▸ Settings ▸ Accounts ▸ "+" ▸ sign in with your Apple ID
                      # (this creates your free "Personal Team")

# every time you want to (re)install
npm run build -w packages/core        # shared engine → dist/
cd mobile
npx expo prebuild --platform ios      # generates mobile/ios (gitignored)
npx expo run:ios --device             # pick your iPhone; builds + installs + launches
```

First run only:
1. Xcode may ask you to pick a development team — choose your Personal Team.
   If signing fails on the bundle id, change `ios.bundleIdentifier` in
   `mobile/app.json` to something unique (e.g. `com.<yourname>.smartwake`).
2. On the iPhone: **Settings ▸ General ▸ VPN & Device Management ▸ trust your
   Apple ID** — otherwise the app won't open.
3. Allow **Alarms** (the AlarmKit prompt) and **Notifications** when the app
   asks. You can re-request both from the app's Settings tab.

**The 7-day rule.** A free Personal Team signs the app for 7 days. After that
the icon stays but the app refuses to launch until you run
`npx expo run:ios --device` again (≈ 1 minute; the phone can stay on Wi-Fi).
Put a weekly reminder in your calendar. A paid Apple Developer account
($99/yr) extends this to a year — nothing in the code changes.

**Expo Go does not work** for this app: AlarmKit is a native module, so you
must use the dev build produced by `expo run:ios` (this is what the commands
above do).

## 2. How alarms are delivered (three tiers, all offline-capable)

| Tier | Mechanism | When it rings | Stops when |
|------|-----------|---------------|------------|
| 1 | **AlarmKit system alarm** (iOS 26) scheduled at every *latest-wake* time for the next 7 days | At the deadline — even if the app is closed, phone locked, silent mode or Focus on | You press Stop/Snooze on the system alarm UI (rings until then) |
| 2 | **Bedside mode** (app open on the nightstand) | As soon as light sleep is detected inside the wake window (the smart part) | You tap **I'm awake** in the app (sound + haptics loop until then) |
| 3 | **Backup notification chain**: a local notification with sound every 30 s from 1 min after the deadline for 10 min | If, for any reason, nothing else stopped you sleeping | You open the app from a notification and confirm awake, or the chain runs out |

Design rule inherited from the whole project: **the deadline alarm never
depends on network, sleep data or the app being open.** Tier 1 alone
satisfies "vibrates until I stop it"; tiers 2–3 add the smart wake and the
belt-and-braces chain the user asked for.

Why smart wake needs Bedside mode: iOS suspends background apps, and a free
Apple ID cannot use push notifications, so the light-sleep decision has to run
in the foreground. Bedside mode keeps the screen awake, plays through silent
mode, and keeps audio alive if you lock the screen (background audio mode).

## 3. Custom wake times
Alarms tab ▸ **Add custom wake time**: time, optional label, weekdays (none =
every day), and a smart window (0 = exact). Custom alarms get the same three
tiers as prayer alarms.

## 4. Sleep data today vs. later
Today the app uses the shared **mock Fitbit Air simulator** (honest ~15 min sync
lag, realistic sleep cycles). The Bedside tab's **Demo night (60× speed)**
shows the full flow in about a minute. Real Fitbit Air data comes from the
Google Health API via on-device OAuth — see `docs/ROADMAP.md` (Phase M2) and
`docs/INTEGRATIONS.md`. The provider seam (`SleepDataProvider` in
`packages/core`) is the only thing that changes.

## 5. Files
```
mobile/app/_layout.tsx        boot: permissions → prayer times → arm alarms; notification tap → Bedside
mobile/app/(tabs)/index.tsx   Tonight: next alarm plan, prayer times, hypnograms
mobile/app/(tabs)/alarms.tsx  prayer alarms + custom wake times
mobile/app/(tabs)/bedside.tsx smart-wake runtime (engine tick loop, in-app alarm, demo)
mobile/app/(tabs)/settings.tsx location/method/permissions
mobile/src/store.ts           persisted state (zustand + AsyncStorage) incl. append-only events[]
mobile/src/services/
  alarmKit.ts                 AlarmKit wrapper (no-op where unavailable)
  notificationChain.ts        backup chain + notification permission/handler
  inAppAlarm.ts               audio loop + haptics + keep-awake
  prayerTimes.ts              Aladhan fetch/cache for today..+7
  replan.ts                   plan (core) → device alarms; confirmAwake()
  sleep.ts                    mock provider factory + seeded history
  background.ts               opportunistic daily refresh task
mobile/assets/alarm.wav       generated alarm sound (notifications + AlarmKit + in-app)
```

## 6. Verifying without a Mac (CI / Linux)
`npm run build` type-checks the app; `cd mobile && npx expo export --platform ios`
bundles it with Metro; `npx expo prebuild --platform ios --no-install`
generates the Xcode project so config-plugin output (Info.plist keys, deployment
target, bundled sound) can be inspected. Actually running it requires the Mac
steps in §1.
