### Fixed

- trader-ui: every drawing tool is clickable along the whole shape it draws, not just between its anchor points. Rays, extended lines, cross lines, fans, pitchforks, fib circles and time zones paint far outside their anchors, but the hit test only measured the polyline between them — so most of a line was dead to the pointer. Each tool is now hit-tested against its real geometry, and hidden drawings are excluded (#3354)
