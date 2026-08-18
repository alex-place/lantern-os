### Fixed

- trader-ui: an armed drawing tool now owns the chart. Pan, zoom and phone scrub are locked while a tool is selected, so a multi-point shape no longer fights the chart moving between clicks, and the plot shows a crosshair to say so. Two-point shapes (trend, ray, rectangle, fib, measure) can be drawn in one press-drag-release gesture; click-click still works, and three-point tools still take three clicks (#3354)
