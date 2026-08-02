change(trader): chart panels are square and stay the same size

Every chart panel in a fixed layout is now the largest square that fits the deck, and
all panels in a layout are identical (#3138, #3139). Fixed layouts had opted out of the
square shape the free-flow grid already used, so panels were wide rectangles whose shape
changed with the window, the chat rail, and the order panel. A card with an open
position also spanned two grid columns, so opening a position silently doubled that
panel's width and re-flowed the rest of the deck; it now changes only the border colour.
