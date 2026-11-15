---
title: Decision: every feature flag has an expiry date
type: decision
date: 2025-11-12
---

# Decision: every feature flag has an expiry date

Every feature flag gets an owner and an expiry date at creation. Proposed by Bram Oyelaran, accepted at architecture review.
Flags past expiry fail the build until removed or renewed.
