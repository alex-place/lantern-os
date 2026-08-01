fix(auth): a sign-in that can't set a cookie now fails loudly instead of returning ok

On any locally-launched server that had `PORT` set, the session cookie was marked
`Secure`; on plain-http localhost express-session then saved the session and emitted
no `Set-Cookie` at all. Every sign-in — role picker, email+password, OAuth — replied
`200 {ok:true}` and left the user a guest, with no error anywhere (#3010).

The flag now tracks the actual connection outside production (`secure: "auto"` with
the proxy already trusted); production stays hard-Secure, keeping #2618's fail-closed
rule. And `establishSession` refuses outright when the cookie could not reach the
browser, returning `secure_cookie_on_http` rather than a cheerful lie.
