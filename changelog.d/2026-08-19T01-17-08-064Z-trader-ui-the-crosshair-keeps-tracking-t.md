### Fixed

- trader-ui: the crosshair keeps tracking the mouse while a drawing is being dragged. Each pointermove was calling renderZoneLadder, which rewrites overlay.innerHTML and destroys the crosshair elements — so editing a shape froze the chart's mouse tracking. A drag now repaints only the canvas pixels and does the full DOM rebuild once, on pointerup (#3354)
