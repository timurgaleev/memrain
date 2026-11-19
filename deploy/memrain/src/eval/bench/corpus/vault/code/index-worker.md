---
title: index_worker service
type: code
date: 2025-11-12
---

# index_worker service

`index_worker` consumes document change events from the broker and updates the Kestrel index.
Function `apply_change(event)` is idempotent on the event id. Backfill uses `reindex_range(start, end)`.
