### Fixed

- trader-ui: a cancel only reports success after the broker confirms the order is off the book. The bridge returns `{ok:false}` objects and the route treated them as booleans — `{ok:false}` is truthy, so a failed own-account cancel toasted "✓ Canceled", the operator fallback never ran, and the order kept resting while the UI said it was gone. Results are normalized, the cancel is verified against a re-read of open orders (one retry for IBKR's acknowledgement lag), and an acknowledged-but-still-working order returns `cancel_not_confirmed` instead of a false toast
