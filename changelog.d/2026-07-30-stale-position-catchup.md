### Fixed
- **A missed exit window can no longer strand an overnight position.** The 09:31–09:50
  ET window was the *only* exit path: on 2026-07-29 the engine was down across it, a
  10-leg 0-DTE call ladder was never sold, and it expired worthless (−$2,006 total
  loss). The server was back at 15:38 ET — still inside the session — so a late exit
  would have sold them. Any tick that now finds a position from a prior date exits it
  for the rest of the session (to 15:55 ET), flagged `late` so catch-ups stay
  separable from clean 09:31 fills and don't quietly pollute measured expectancy.
  A missed window degrades to a worse fill, never to no exit.
