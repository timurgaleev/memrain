# Fireflies connector

Memrain can read your Fireflies meeting transcripts into a `meeting` source.
Each transcript becomes one untrusted meeting page: participants, the
Fireflies summary and action items when Fireflies has produced them, and the
transcript as speaker turns with the time each turn began. Participants who
already have a `people/` page in the meeting source or the default source get
an `attended` link; everyone else becomes a wanted entry, never a page. A long
transcript is stored whole across part pages.

Everything a transcript holds is outside text from whoever spoke in the
meeting. It is secret-scanned, framed as untrusted, and passes the write gate
as external text. Nothing in it is ever acted on.

## Off by default

Nothing runs until all of these hold:

- `MEMRAIN_CONNECTORS_ENABLED=1` and a loadable connector key (see
  CONFIGURATION.md);
- the account is enabled after you save the key (a new account starts
  disabled);
- the daily budget and the account's caps allow the run.

## Connect

1. In Fireflies, copy your API key (Integrations, Fireflies API).
2. Create a source of kind `meeting` if you do not have one.
3. Save the key through the admin API:

   ```
   POST /admin/api/connectors/fireflies/key
   {"source_id": "<meeting source>", "api_key": "<your key>"}
   ```

   Memrain asks Fireflies who owns the key (the `user` query), seals the key
   in the connector vault, and answers with the account. The key is never
   echoed back, logged, or written to a page.
4. Enable the account.

Saving a working key again for the same Fireflies user replaces the sealed
key and resumes an account that was paused as `needs_reconnect`, from where
it stopped.

## What a sync does

- The first run lists transcripts created in the last 90 days; later runs
  list the window since the previous run, plus 48 hours, so a summary that
  arrives after the meeting is picked up. Only transcripts whose title, time,
  length, people or summary status changed are fetched again.
- About once a day every transcript id the key can see is listed. A stored
  transcript missing from that list is asked for by id, and only a
  "not found" answer deletes it: its page, parts, chunks, embeddings, links
  and facts are hard-deleted with a receipt that holds no meeting text. More
  than the mass-delete threshold at once is held for you instead.
- Requests are spaced two seconds apart and counted against 500 a day, the
  free plan's allowance; Fireflies' own refusal is handled as a rate limit,
  and the run continues on the next schedule.
- A key Fireflies refuses pauses the account as `needs_reconnect`, opens a
  notice and keeps every page and cursor.

Memrain only sends queries; it never sends a mutation. Fireflies keys carry
the owner's full access, so treat the key like a password and revoke it in
Fireflies when you disconnect.
