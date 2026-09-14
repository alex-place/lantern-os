### Fixed

- journal: **a layout Reset reaches every device.** Reset the card layout on one device and another device kept the old arrangement for good, because the page only took the account's layout when there was one. When the account says there is no layout, the browser's first-paint copy goes too and the default paints. A guest's browser copy stays, and a failed fetch still changes nothing.
