# Putting the watch app on the App Store

A watch in Family Setup can't install apps from Xcode, so the way to get the app onto one is the App Store, or TestFlight while it's in beta. The app itself is ready. This page has everything for the submission: the listing text, the privacy answers, the screenshots, and the steps.

**Who does what:** the [Apple Developer Program](https://developer.apple.com/programs/enroll/) costs $99 a year and needs someone 18 or older, so a parent enrolls and submits. Their name appears on the App Store as the seller.

## What's already done in the repo

- **Icon:** `watch/ClaudeNotes/Assets.xcassets/AppIcon.appiconset/icon.png`, 1024×1024 with no transparency.
- **Privacy manifest:** `watch/ClaudeNotes/PrivacyInfo.xcprivacy`. It declares no tracking, no collected data, and the reason the app uses UserDefaults (its own draft, history and settings).
- **Name on the watch:** Hand-Off, matching the App Store name.
- **Watch-only and standalone:** it needs no iPhone app and works without a phone nearby.
- **Screenshots:** in `screenshots/`, for the Ultra 3 (422×514) and both SE 3 sizes (368×448 and 324×394). To make them again after changing the app, run `node test/app-store-screenshots.mjs`. It builds for the simulator only.
- **Privacy policy:** [PRIVACY.md](../../PRIVACY.md), at `https://github.com/maxvbuda/handoff/blob/main/PRIVACY.md`.

## Steps (for the parent)

1. **Enroll** at developer.apple.com/programs/enroll as an individual.
2. **Sign in to Xcode** with that Apple ID (Xcode → Settings → Accounts).
3. **Set the team.** In `watch/`, run `xcodegen generate`, open `ClaudeNotes.xcodeproj`, choose the ClaudeNotes target → Signing & Capabilities, and pick the new team. If Xcode says the bundle ID `dev.maxbuda.ClaudeNotes` is taken, change it in `project.yml` to something like `com.<yourname>.ideas` and generate again.
4. **Create the app** in [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+** → New App. Use the bundle ID from step 3 and the name below. Watch-only apps are created under the **iOS** platform, and the build you upload is what makes it a watch app.
5. **Upload a build.** In Xcode, set the destination to **Any watchOS Device**, then Product → Archive. In the Organizer, choose Distribute App → App Store Connect → Upload.
6. **Try it with TestFlight first (optional).** Add testers in App Store Connect → TestFlight. Developers report mixed results with TestFlight on Family Setup watches, so if it doesn't show up on the watch, go straight to step 7.
7. **Fill in the listing** with the text below, add the screenshots, answer the questions, and click **Submit for Review**. Once it's approved, install it from the App Store on the watch. With Ask to Buy on, the parent approves the download.

## The listing

**Name** (30 characters max, must be unique on the App Store): **Hand-Off**

Keep the hyphen. "Handoff" as one word is an Apple trademark (App Review Guideline 5.2.5), and if review still finds Hand-Off too close, the fallback is **Baton: Ideas to Mac**. Don't use "Claude", which is Anthropic's trademark (5.2.1).

**Subtitle** (30 max): `Jot it on your wrist. Done.`

**Promotional text** (170 max):
> Dictate an idea on your watch, and the coding assistant on your Mac starts on it while you're away. Encrypted end to end, with nothing to read on your wrist.

**Description:**
> Hand-Off turns your Apple Watch into an inbox for the AI coding assistant on your Mac.
>
> Think of a fix or a feature while you're out? Dictate or scribble it on your watch and tap send. It goes straight to the Claude Code session running on your Mac, which starts working on it. When you get home, it's done.
>
> • Made for quick thoughts: no responses to read on your wrist, nothing to get pulled into. Just a tap and a checkmark.
> • Accept a suggestion: when a task is finished, your Mac can suggest the next step. Tap once to send it.
> • Several projects: pick which chat a note goes to, or start a new one in any project folder on your Mac.
> • Private by design: notes are end-to-end encrypted on the watch with a key only your watch and Mac share. The relay in between only ever sees scrambled data. No accounts, no analytics, no tracking.
> • Works on its own: no iPhone needed. Uses your watch's Wi-Fi or cellular, and holds notes until it's back online.
>
> Requires a Mac running Claude Code with the free, open-source Handoff plugin (github.com/maxvbuda/handoff). Pair once with a short code.
>
> Not affiliated with Anthropic.

**Keywords** (100 max): `ideas,notes,dictation,coding,developer,mac,ai,assistant,inbox,todo,programming,wrist,voice`

**Support URL:** `https://github.com/maxvbuda/handoff/issues`
**Marketing URL** (optional): `https://github.com/maxvbuda/handoff`
**Privacy Policy URL:** `https://github.com/maxvbuda/handoff/blob/main/PRIVACY.md`

**Category:** Developer Tools, with Productivity as the secondary.
**Price:** Free.
**Age rating:** answer **None** to every question, which gives 4+.

## App Privacy ("nutrition label")

Choose **Data Not Collected**. Apple counts data as collected when it leaves the device in a way that you or a third party can access. Notes leave the watch end-to-end encrypted, and only the user's own Mac has the key. The developer runs no servers, and ntfy.sh only relays ciphertext. PRIVACY.md has the details.

## Export compliance (encryption question)

The app uses encryption: HTTPS, plus AES-GCM from Apple's CryptoKit to encrypt notes. When App Store Connect asks, the answer that matches is that the app **uses encryption within Apple's operating system** (CryptoKit and URLSession), not its own encryption code. Apple treats that as exempt. If you're unsure, Apple explains each answer in [Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations). `project.yml` already sets `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption: NO`, which gives that answer, so App Store Connect shouldn't ask on each upload.

## Notes for the reviewer

App Review has to be able to try the app, and it does nothing until it's paired with a Mac. Paste this into **App Review Information → Notes**, and attach a short screen recording of pairing and sending a note (a phone video of the watch next to the Mac is fine):

> This watch app sends notes to the user's own Mac, where the free open-source `handoff` command for Claude Code (Anthropic's coding assistant) receives them. To try it: on a Mac with Claude Code and Node.js installed, run `npm install -g github:maxvbuda/handoff` in Terminal. Run `handoff pair` in Terminal and enter the 8-character code on the watch. Then run `handoff start` in any folder, dictate a note on the watch, and tap send: it appears in that Claude Code session. Notes are end-to-end encrypted; the relay (ntfy.sh) only sees ciphertext. The attached video shows the full flow.

**Sign-in required:** no. There are no accounts.
