### Fixed

- trader: **the layout chip says what the grid shows.** Load the page with one chart saved and the toolbar chip read "All"; it only caught up after you switched by hand. The chip over the layout select learns a value through the select's change event or a sync call, never from a bare value write, and the load-time rebuild of the options wrote the value bare. Every way of changing the layout (the chip, the 0 to 6 keys, "Back to grid", the phone migration) now tells the chip.
