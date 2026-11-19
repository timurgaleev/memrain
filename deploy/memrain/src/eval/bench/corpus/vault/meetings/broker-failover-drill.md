---
title: Broker failover drill
type: meeting
date: 2025-11-12
---

# Broker failover drill

Attendees: Tomasz Wierzba and the Beacon rota.
The managed broker failed over in ninety seconds. Two consumers did not reconnect and needed a restart.
Action: add reconnect backoff to the indexing worker and the reminder sender.
