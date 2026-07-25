### Added

- settings/trading: restored the **Active broker** switch (Auto / ⚡ Alpaca / 🔗 IBKR) in
  Settings → Connections, now **alongside** the Active-trader switch. It picks which
  connected broker the stock day-trader executes through, and only appears when **both**
  brokers are connected (otherwise there is no choice to make). Updates in place, backed
  by the existing `/api/broker/preference`. This is needed while IBKR is still connected
  on preview/local so the operator can flip the day-trader between Alpaca and IBKR;
  Champion always runs on Alpaca regardless. (The earlier standalone broker-switch PR was
  closed when the trader switch replaced it; this brings the control back as a companion
  to it rather than a replacement.)
