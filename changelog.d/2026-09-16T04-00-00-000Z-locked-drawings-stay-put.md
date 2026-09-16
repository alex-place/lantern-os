### Fixed

- trader: **a locked drawing is actually locked.** The lock was checked in one place only, so a locked drawing could still be dragged by its handles, deleted with the Delete key, alt-clicked away, or erased by the eraser. Every one of those asks now, and the ones that would have removed it say why nothing happened. Selecting a locked drawing still works, since that is how you reach the unlock button.
