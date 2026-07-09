feat(auth): Terms of Service + EULA with signup consent gate

New public `/terms.html` page — a 21-section Terms of Service + End-User
License Agreement tailored to the app (AI-output/hallucination disclaimer,
"not financial/legal/medical advice", data ownership + local-first, telemetry,
third-party AI providers, EULA license grant, no-warranty, liability). Served
publicly (added to `routes/pages.js` PUBLIC_PAGES + `deployment-profile.js`
HOSTED_SURFACES) so a signed-out user can read it before agreeing.

auth.html now shows an affirmative "I agree to the Terms of Service & EULA"
checkbox ONLY in account-creation (register) mode, immediately above the
Create-account button. It is unchecked by default and gates registration
client-side; normal sign-in, OAuth, and guest entry are unaffected. Registered
in `surface-registry.js` under the account cluster (MAX_EXTENSION_RATIO raised
0.95→1.0 deliberately for this legally-required shell surface).

Note: the Terms text ships with bracketed placeholders ([LEGAL ENTITY],
[JURISDICTION], [CONTACT EMAIL], [EFFECTIVE DATE]) and requires legal review
before real launch. Strengthens the account shell; supports the Verify/consent
posture. Verified in preview: gate blocks unchecked signup, passes when checked
(register POST 202), Terms page loads publicly.
