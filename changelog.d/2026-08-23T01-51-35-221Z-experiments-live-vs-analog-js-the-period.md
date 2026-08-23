### Changed

- experiments/live_vs_analog.js: the periodic check — the live week from both ledgers (engine-originated exits only; shared-account reconstructions are ignored), fingerprint audit of the armed configuration (entries inside the hourly decision windows, validated exit paths only, no config_warning, same-minute entries in tilt order), measured costs (entry quote→cost, exit mark→fill: live ≈ +2.5 bp / −4.7 bp vs the labs' 5 bp each way), and the armed stack replayed on the window's own 5-minute bars. 8/03–8/21: live +$11.3k payoff 1.04 vs analog +3.31% payoff 1.21.
