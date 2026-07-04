; unisona.iss — Inno Setup script for the unisona.ai desktop app (direct-download
; / SignPath channel). Produces a per-user installer (no admin, no UAC) that lays
; unisona.exe + the app tree into %LOCALAPPDATA%\unisona. See ADR-0014 and
; scripts/build-desktop-installer.mjs (which stages the payload and invokes ISCC
; with the /D defines below).
;
; Compile:  ISCC /DAppVersion=1.8.x /DStagingDir=<abs> /DOutputDir=<abs> unisona.iss
; (normally driven by: node scripts/build-desktop-installer.mjs)

#define AppName "Unisona"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StagingDir
  #define StagingDir "dist\staging"
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif

[Setup]
; A stable, unique AppId keeps upgrades/uninstalls tied to one product across versions.
AppId={{8F3A2C1E-5B9D-4E7A-9C21-6D4F0A8B3E52}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Unisona
AppPublisherURL=https://unisona.ai
DefaultDirName={localappdata}\unisona
DefaultGroupName=Unisona
DisableProgramGroupPage=yes
; Per-user install — no administrator rights, no UAC prompt (friendlier for an
; unsigned/newly-signed exe that SmartScreen hasn't built reputation for yet).
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Unisona-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Brand icon for Setup.exe + the wizard + Add/Remove Programs. The shortcuts and app
; taskbar entry get their icon from unisona.exe (embedded via rcedit at build time),
; and the app window itself from the served favicon. Path is relative to this .iss.
SetupIconFile=unisona.ico
UninstallDisplayIcon={app}\unisona.exe
UninstallDisplayName={#AppName}

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
; The whole staged payload → {app}. Staging (build-desktop-installer.mjs) already
; excluded build output, build-only deps, .git and secrets.
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Unisona"; Filename: "{app}\unisona.exe"
Name: "{group}\Uninstall Unisona"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Unisona"; Filename: "{app}\unisona.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\unisona.exe"; Description: "Launch Unisona now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Runtime state lives in %APPDATA%\unisona (UNISONA_DESKTOP), left in place on
; uninstall so the user keeps their memory/keys. Only remove the installed program
; files here (Inno removes {app} contents it installed automatically).
Type: dirifempty; Name: "{app}"
