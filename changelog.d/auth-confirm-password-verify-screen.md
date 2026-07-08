feat(auth): confirm-password on signup + dedicated confirm-email screen

Creating an account now asks the user to **confirm their password**: a second
field appears only in "Create account" mode, and the two entries must match
exactly (case-sensitive) before the request is sent — a mismatch is rejected
client-side with "Passwords don't match."

Pending email verification is now its own **full screen** instead of an inline
banner. After signup (or a login blocked by an unconfirmed address) the sign-in
card is replaced by a focused "Confirm your email" view that shows the address
and offers three actions: **Resend confirmation**, **← Back** to the previous
screen, and **I've confirmed my email — sign in** (returns to the login screen,
pre-filled). Clicking the emailed confirmation link continues to land on the
login screen (`?verify=1`) with the "Email confirmed ✓" banner.

Frontend-only change to `apps/lantern-garage/public/auth.html`; the register /
resend / verify-email endpoints are unchanged.
