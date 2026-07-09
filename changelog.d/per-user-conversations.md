feat(chat): per-user conversation persistence — a logged-in user's chat history is
now stored under their PROFILE (data/conversations/users/<userId>/), so it follows
the account across devices instead of the client's localStorage sessionId. Fixes a
cross-user privacy leak where /api/conversations/sessions returned every user's
session titles/previews to everyone: the session list, per-session read, and clear
are now scoped by the session-resolved profile id (getEffectiveUserId), operators
keep the whole-instance view, and guests fall back to the shared device-local log
scoped by sessionId. Identity is resolved server-side, never trusted from the body.
