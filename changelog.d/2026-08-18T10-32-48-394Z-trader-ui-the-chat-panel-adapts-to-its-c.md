### Fixed

- trader-ui: the chat panel adapts to its column and opens at a proper width. It kept the fixed 360px it needed as a right-edge overlay, so inside a 300px dock column it overflowed and clipped — and dragging the column did nothing, because the panel's own width never changed. Adopted panels are fluid in both axes now, and the chat column defaults to the 360px the chat was designed for rather than a squeezed 300. The order ticket had the same defect at 340px in a 320px column (#3355, #3356)
