### Changed

- trader-ui: the popups share one material — modals at a single corner and shadow, flyouts and menus at a second, controls at a third. Two token insertions from earlier passes were dead on arrival because the same property was declared again later in the block; a duplicate-property audit found both (#3355)
