# Lantern Desktop Tester

Status: public-safe tester packet, not v1.0.0.

Use this when someone asks:

```text
You got something for me to download and test?
```

Answer:

```text
Yes. I have a Windows desktop tester build of Lantern OS.

Download: https://github.com/alex-place/lantern-os/releases/latest
Free tester: Lantern-OS-Free-Setup.exe
$20 founder/support tester: Lantern-OS-Founder-20-Setup.exe, only after payment/support receipt is confirmed
Zip fallback today: artifacts/lantern-desktop-tester-latest.zip
Zip fallback requirement: Node.js 20 or newer
Zip fallback run: .\Start-LanternDesktopTester.ps1
Lantern front door: http://127.0.0.1:4177

Test the dashboard, chat, demo deck, local/cloud URL map, and safe command lane.
Do not enter secrets, private keys, seed phrases, payment credentials, or Discord
tokens. This is a tester build, not v1.
```

## Gage Windows Install

Preferred path:

1. Open `https://github.com/alex-place/lantern-os/releases/latest`.
2. Download `Lantern-OS-Free-Setup.exe`.
3. Run the installer.
4. Open Lantern from the Start menu or desktop shortcut.
5. If the browser does not open, go to `http://127.0.0.1:4177`.

Paid/support path:

1. Use `https://ko-fi.com/alexplace` or another operator-approved payment
   method outside the repo.
2. Treat `$20` as founder/setup support only.
3. After payment clears, use `Lantern-OS-Founder-20-Setup.exe` only if it is
   attached to the latest GitHub Release.
4. If the founder `.exe` is not attached yet, use the free `.exe` or zip
   fallback. The support receipt changes the support lane, not the security
   boundary.

The `$20` version is not equity, not securities, not a token, not ownership, not
admin access, not an investment return, and not a promise of profit.

Wiki source for these instructions:

```text
docs/wiki/WINDOWS-TESTER-INSTALL.md
```

## One Front Door

Lantern has one interactive front door:

```text
http://127.0.0.1:4177
```

Old static pages such as Tony Garage, Shareholder Index, Agent Fleet, and
Lantern Desktop are retired redirect surfaces. They should not act like separate
front pages.

## What Testers Get

- A local Lantern dashboard.
- Chat-first interaction.
- The $1000 demo slideshow.
- 20-panel Art Matrix.
- Lantern Reader access to public-safe evidence cards.
- Local/cloud URL map.
- Wallet truth with cleared cash separate from invoices.
- Safe command lane for `!one`, `!converge`, and `!superjarvis`.
- Discord/voice docs, but no live bot token or voice mutation.

## Lantern Reader Pack

Open the bounded game-theory and wargame reader card:

```text
http://127.0.0.1:4177/view?path=manifests/evidence/game-theory-wargame-reader-2026-05-29.md
```

This card indexes five local PDFs by metadata, hashes, page counts, and
compressed strategy signals. It does not copy book text into the repo. Use it
for strategy modeling, custom HFT/spread simulation, and game/wargame decision
practice, not live trading or operational military guidance.

## What Testers Should Report

- Did the start script open the dashboard?
- Did chat answer?
- Did the demo deck explain what Lantern sells?
- Did the Lantern Reader open the game-theory/wargame card?
- Did any link still point to an old front page?
- Did any feature imply fake revenue, fake cloud health, or fake Discord access?

## Build The Packet

From the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-LanternDesktopTesterPackage.ps1
```

Output:

```text
artifacts/lantern-desktop-tester-latest.zip
```

The package excludes `.git`, `node_modules`, secrets, conversation logs,
credentials, and live tokens.

Release asset names to use when the Windows installer lane exists:

```text
Lantern-OS-Free-Setup.exe
Lantern-OS-Founder-20-Setup.exe
lantern-desktop-tester-latest.zip
```
