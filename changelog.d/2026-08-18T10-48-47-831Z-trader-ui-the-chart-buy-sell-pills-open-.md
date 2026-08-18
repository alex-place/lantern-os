### Fixed

- trader-ui: the chart BUY/SELL pills open the order ticket even when its column is closed — they were filling a 0px-wide panel and looking dead. Clicking a drawing to select, move or delete it is now practical: the hit target went from 9px to 14px and the pointer turns into a move cursor over a drawing, which is the affordance that was missing (#3354, #3357)
