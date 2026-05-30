# Lantern Chat Bookmark

Status: issue #13 fixed entrypoint contract.

The stable operator action is a Windows shortcut or bookmark that opens the
validated Lantern chat surface. It does not require Windsurf, an IDE, a remote
tunnel, or a fake dashboard.

## One Command

Create or refresh the desktop shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-LanternChatShortcut.ps1
```

Create or refresh the Start Menu shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-LanternChatShortcut.ps1 -StartMenu
```

Validate without writing a shortcut:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-LanternChatEndpoint.ps1
```

## URL Selection

The validator checks local-first candidates in this order:

1. `http://127.0.0.1:8787/chat`
2. `http://127.0.0.1:8788/chat`
3. `http://127.0.0.1:8787/`
4. `http://127.0.0.1:8788/`
5. `http://127.0.0.1:4177/`

On the current local app, `http://127.0.0.1:4177/` is the working chat-first
Lantern surface. The script selects the first URL that returns HTTP success and
contains chat markers such as `Lantern Cloud Chat`, `Message Lantern OS`,
`conversationForm`, or `chatPanel`.

## Remote / Tunnel Rule

Remote URLs are blocked by default. Use `-AllowVerifiedRemote` only after the
operator has separately verified the tunnel or AWS URL. A remote response is not
trusted just because it exists.

## Output

`New-LanternChatShortcut.ps1` prints:

- `shortcutPath`;
- `targetUrl`;
- validation results for each checked URL.

If no chat URL validates, no shortcut is created.
