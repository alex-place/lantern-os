### Fixed

- trader-ui: closing a panel now really gives its column back. Enumerating the closed-state combinations was wrong — body.leftdock-closed and body.ticket-closed have equal specificity, so with both set the later rule won and re-expanded the left column, leaving the chat's 360px behind. Each column's width is its own variable, zeroed by its own class, which cannot collide (#3355)
