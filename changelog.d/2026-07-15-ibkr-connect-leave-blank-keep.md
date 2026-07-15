### Fixed

- trader: the IBKR connect form advertised "saved — leave blank to keep" on credential fields but the server rejected blank fields (`missing_signaturePem`); `POST /api/trading/ibkr/connect` now fills blank fields from the user's stored (encrypted) credentials before validating, so partial updates work. New users with nothing saved still must supply every field.
