### Fixed

- trader: **the eraser erases.** Arming it and clicking a drawing left the drawing where it was and quietly added an invisible object to the chart, then disarmed itself. It now deletes what you click and stays armed for the next one, which is what its own description promised.
- trader: **the highlighter can be drawn.** Dragging with it did nothing at all, and clicking left an invisible one-point stroke. Both brushes are now driven by the catalogue that already marks them as drag tools, so the highlighter draws exactly the way the brush does.
- trader: **a regression trend's handles sit on the channel.** That tool is fitted to the bars its span covers, so its handles were left floating a hundred pixels above the thing they resize, over empty chart. They sit on the ends of the fitted line now.
