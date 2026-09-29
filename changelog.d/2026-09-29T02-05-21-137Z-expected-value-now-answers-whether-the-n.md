### Changed

- Expected value now answers whether the number is any good: the scan publishes the gate it actually acts on (EV_MIN and P_MIN) and the hero states the figure against it — anything above zero is an edge in the model's view, the engine only acts above +0.15 R, and the current reading is about 5.2x that bar. The threshold is read live rather than written into the copy, so retuning the gate can never leave the sentence lying.
