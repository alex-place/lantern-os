docs(ops): record unisona.ai → GCE tunnel cutover in the deploy runbook. unisona.ai now
serves from the VM via a second connector (`cloudflared-unisona`, tunnel `1b1c2acf`,
Cloudflare account `ff492ab2…`) instead of the operator's PC, fixing the 502. Documents
the two-account/two-tunnel topology, the cross-account CNAME constraint, and the
from-scratch recreate steps.
