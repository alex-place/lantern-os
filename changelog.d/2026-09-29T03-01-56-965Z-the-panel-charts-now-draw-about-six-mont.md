### Changed

- The panel charts now draw about six months of daily closes instead of five hours of five-minute bars, and each says which window it is showing. The old view spanned zero days with a 0.2 percent price range, which is why it drew a flat line; the daily view over the same symbols covers roughly 173 days and a 15 percent range, so the shape that matters is actually visible. The window label is derived from the bars' own timestamps rather than the requested limit, so a short history reports what it really got.
