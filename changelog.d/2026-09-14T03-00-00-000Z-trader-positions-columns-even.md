### Fixed

- trader: **the positions and orders tables space their columns evenly.** The browser was handing spare width to columns in proportion to their content, so a long header like UNREALIZED P&L got a wide gap while SIDE and QTY sat cramped. Every data column now asks for the same share of the table (the symbol column a fixed share, the actions column only its buttons), so the values line up under their headers at even intervals; a column whose content needs more takes more, and the table scrolls sideways when they all do.
