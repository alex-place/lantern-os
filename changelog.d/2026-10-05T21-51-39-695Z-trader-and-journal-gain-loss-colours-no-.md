### Fixed

- Trader and journal: gain/loss colours no longer vanish under the Dark Reader extension — the pages load trader.css with a <link> instead of an @import inside their <style> block (the import sent that one block down the extension's slow path, which left an override sheet behind after the extension had switched itself off on our dark theme and painted every figure in its own text colour)
