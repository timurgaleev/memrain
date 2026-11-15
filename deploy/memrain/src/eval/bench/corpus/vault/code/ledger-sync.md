---
title: ledger_sync module
type: code
date: 2025-11-12
---

# ledger_sync module

The `ledger_sync` module pulls settled payments from the processor and writes ledger entries.
Entry point: `reconcile_batch(batch_id)`. It retries a batch three times, then marks it `needs_review`.
Rounding is handled by `round_half_even` on minor units.
