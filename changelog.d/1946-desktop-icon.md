Desktop app is branded (#1946). A multi-resolution unisona.ico (16→256px) is
generated from public/favicon.svg (sharp + png-to-ico) and committed;
build-desktop-exe.mjs embeds it into unisona.exe via rcedit so the shortcut, Start
Menu and taskbar show the Unisona mark, and unisona.iss sets SetupIconFile for
Setup.exe / Add-Remove-Programs. The icon is embedded on the clean node copy BEFORE
postject (rcedit hangs on a postject'd SEA exe; postject preserves the icon).
Verified on Windows: reinstall → exe carries the icon and still boots. Strengthens Act.
