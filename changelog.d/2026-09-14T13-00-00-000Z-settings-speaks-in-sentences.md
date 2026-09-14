### Fixed

- settings: **errors read as sentences, not codes.** Changing the email to something that is not an address said "invalid_email"; a rejected AI key alerted "invalid_key_value"; a cancel with no billing alerted "billing_not_configured". Every modal and alert on the page now translates the server's code the way the password modal already did, and an unknown code falls back to plain words instead of the token. Changing the email to the address already on the account no longer sends a confirmation for nothing; the modal says so.
