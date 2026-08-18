### Fixed

- ui: native dropdowns no longer flash white on a dark page. The site never declared color-scheme, so Chrome painted every <select> popup list — which the OS draws, not our CSS — in the light scheme, and losing hover on an option snapped it to white. One declaration per theme in site.css fixes every native control on every page: selects, scrollbars, date pickers and form fields (#3353)
