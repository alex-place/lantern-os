fix(ops): unfreeze the unisona.ai cloud VM's release auto-deploy. The systemd oneshot
ran with no `HOME`, so `git config --global` died with "fatal: $HOME not set" (exit 128)
on every tick — the box was stuck at v1.8.0 (2026-07-04) while releases advanced to
v1.8.130. Set `HOME` in both the service (`Environment=HOME=/root`) and the script
(`export HOME=${HOME:-/root}`).
