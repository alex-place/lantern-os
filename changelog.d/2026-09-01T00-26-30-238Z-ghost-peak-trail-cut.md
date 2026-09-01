### fix(trading): the ghost peak — a reconciled broker fill now clears the position's excursion state

The operator asked the right question: "why did the SOXL position go negative
if it 'rallied +5.4%'?" It never rallied. Monday's SOXL entered at $112.01,
topped at +0.2%, and was trail-cut at −$878 for a "give-back from peak +5.4%"
— $112.01 × 1.0542 = $118.08, exactly where FRIDAY's SOXL position topped out.
`_peak`/`_trough` only ever grow against their existing value, and the
feed-visible fill reconciler (`_reconcileFills`, the road most protective stops
travel) cleared intent/excursion but not the excursion maps or entry clocks —
so the peak survived two stop fills and a weekend, poisoned Friday's second
position's journaled MFE (6.42%, equally impossible), and cut Monday's healthy
re-entry against a three-day-old high.

Two layers: the reconciler now deletes `_peak`/`_trough`/`_entryAt`/
`_holdClockAt` with the fill (the row still carries the excursions it froze —
rows are built before cleanup), and entry placement resets `_peak`/`_trough`
so no upstream leak can ever poison a fresh position again. Three tests pin it.
