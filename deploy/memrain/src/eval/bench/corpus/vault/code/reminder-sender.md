---
title: reminder_sender service
type: code
date: 2025-11-12
---

# reminder_sender service

`reminder_sender` schedules Heron reminders. `next_send_time(appointment)` respects the clinic quiet hours.
Messages go through the text gateway client `sms_client.send`.
