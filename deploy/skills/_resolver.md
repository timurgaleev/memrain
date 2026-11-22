# Skill Resolver

The dispatch map of the skill pack. Each skill's frontmatter `triggers:` are
the routing signal; this page lays them out in one place. The skill table
below is generated from that frontmatter by `scripts/generate-plugin-tree.ts`
in `deploy/memrain`, so edit the skills, not the table. The text outside the
generated block is written by hand and kept across regenerations.

Match the request against a skill's triggers and purpose, then read it with
`get_skill` and its slug before acting. When two skills could match, read
both: they are written to chain (ingest, then enrich each entity). Writes: the
skill changes the brain. Ships in: plugin (also copied into the Claude Code
and Codex plugin), operator only (host-side work, never in the plugin), brain
(served by the brain only); prompt marks the skills also offered as MCP
prompts.

<!-- BEGIN GENERATED: skill table, from frontmatter by scripts/generate-plugin-tree.ts -->

| Skill | Use it for | Triggers | Writes | Ships in |
|---|---|---|---|---|
| `academic-verify` | Verify a research claim or academic citation by tracing it through publication → methodology → raw data → independent replication. | "verify this academic claim", "check this study", "academic verify", "validate citation", "is this study real", "Retraction Watch" | yes | brain |
| `advisor` | Proactive "make the most of the brain" coaching. | "what should I do to get more out of the brain", "is my brain set up right", "brain advisor", "advise me on my brain", "weekly brain checkup" | no | brain |
| `archive-crawler` | Universal archivist for personal file archives (Dropbox/B2/Gmail-takeout/local-mount/hard-drive-dump). | "crawl my archive", "find gold in my archive", "archive crawler", "scan my dropbox for", "mine my old files for" | yes | brain |
| `article-enrichment` | Transform raw article text dumps in the brain into structured pages with executive summary, verbatim quotes, key insights, why-it-matters, and cross-references. | "enrich this article", "enrich the article", "enriching the article", "enrich brain pages", "batch enrich", "enrich pass", "make brain pages useful" | yes | brain |
| `ask-user` | Reusable pattern for presenting the user with explicit choices and gating execution until they respond. | "present options", "ask before proceeding", "choice gate", "user decision" | no | brain |
| `blog-ingest` | Whole-publication ingestion: turn an entire blog, newsletter or RSS/Atom archive into brain source pages. | "ingest this publication", "ingest this whole blog", "ingest this feed", "ingest this newsletter archive", "save this whole substack", "backfill this blog", "walk this rss feed", "ingest every post from" | yes | brain |
| `book-mirror` | Take any book (EPUB/PDF), produce a personalized chapter-by-chapter analysis with two-column tables. | "personalized version of this book", "mirror this book", "two-column book analysis", "apply this book to my life", "how does this book apply to me" | yes | brain |
| `brain-link-discipline` | When you report a brain page to the user (created, edited, or relayed from a subagent), a working link is part of the deliverable, in the same message. | "give me the link", "where is the page", "why does this link 404", "brain link discipline", "rewrite subagent paths", "report the pages you created", "send me a clickable link", "link the page in the same message" | no | plugin |
| `brain-ops` | Brain knowledge base operations. | "any brain read/write/lookup/citation" | yes | plugin |
| `brain-pdf` | Generate a publication-quality PDF from any brain page via the host agent's PDF renderer. | "make pdf from brain", "brain pdf", "convert brain page to pdf", "publish this page as pdf", "export brain page" | no | brain |
| `brain-taxonomist` | Filing gate for ALL brain writes. | "where does this brain page go", "file this in the brain", "brain taxonomist", "taxonomy check", "refile brain page", "create brain page", "which directory does this go", "which directory does this page go" | no | brain |
| `brain-upgrade` | Keep the brain server current. | "brain update available", "upgrade the brain", "update memrain", "update memex", "the brain is out of date", "memrain is out of date", "is the brain up to date", "keep the brain current" | yes | operator only |
| `briefing` | Compile daily briefing with meeting context, active deals, and citation tracking | "daily briefing", "morning briefing", "what's happening today" | no | plugin |
| `bulk-ingestion` | End-to-end discipline for turning a large data source (audio libraries, mail exports, document corpora, chat exports, API dumps) into brain pages at scale. | "bulk ingest", "bulk import", "ingest all", "ingestion pipeline", "mass ingestion", "bulk backfill", "make a manifest", "track a large ingest" | yes | brain |
| `capture` | Save any thought or content into the brain via one CLI command. | "capture this", "save this thought", "remember this", "ingest this into my brain", "drop this in the inbox", "save to brain" | no | plugin |
| `chat-connectors` | Keep the user's chat history flowing into the brain without a manual export each time: Claude Code and Codex sessions pushed when they end, a scheduled import of new local session logs, and ChatGPT or Claude.ai histor... | "keep my conversations synced", "sync my chat history", "auto-import my chats", "connect my chatgpt", "connect my claude account", "push every session automatically" | yes | brain |
| `citation-fixer` | Audit and fix citation formatting across brain pages. | "fix citations", "fix broken citations", "citation audit", "check citations", "citation fixer" | yes | brain |
| `citation-graph-ingest` | Build a typed citation graph over an ingested corpus, not just embeddings. | "citation graph", "typed citation graph", "build a reference graph", "graph over a corpus", "overrules distinguishes graph", "reason over a domain corpus", "trace the argument through these documents" | yes | brain |
| `cold-start` | Day-one data bootstrapping for a new brain. | "cold start", "fill my brain", "bootstrap brain", "import my data", "day one", "get started", "what should I import first", "populate brain", "now what?" | yes | brain |
| `company-brainify` | Build a shared team source from a personal brain without carrying the sensitive parts across: internal ratings, compensation, performance assessments, retention and political dynamics, personal details. | "company brain", "team brain", "brainify", "sanitize the brain", "share my brain with the team", "strip sensitive data from the brain", "scrub employee data", "audit the shared brain", "make the brain safe to share" | yes | operator only |
| `concept-synthesis` | Deduplicate and synthesize raw concept stubs into a tiered intellectual map (T1 Canon to T4 Riff), tracing idea evolution across sources over time. | "concept synthesis", "synthesize my concepts", "find patterns across my notes", "build my intellectual map", "trace idea evolution", "canon vs riff" | yes | brain |
| `connect-client` | Connect a Memrain MCP client using the matching client guide and verify its source and access. | "connect a memrain client", "set up a memrain connector", "configure an mcp client for memrain" | no | plugin, prompt |
| `context-audit` | Token-hygiene audit of the context an agent loads on every turn: the harness's instruction files (CLAUDE.md, AGENTS.md and their equivalents), its auto-memory index, and the brain's own identity pages when the harness... | "context audit", "context diet", "system prompt audit", "prompt compression", "reduce context size", "audit my context stack", "context is too big", "token hygiene" | no | brain |
| `conversation-archive` | Bring chat history into the brain as conversation pages, find out why it did not arrive, and answer questions over the archive ("when did I first discuss X"). | "import my chat export", "import my claude conversations", "chatgpt export", "archive this agent session", "push my session log", "already import this conversation", "conversation import failed", "when did I first discuss", "search my old conversations" | yes | brain |
| `correction-pipeline` | When the user corrects a factual error, trace the wrong claim to where it lives in the brain (a page line, a fact row, a timeline event, or nowhere), fix it at that source with provenance, and check where it spread. | "correct a stored claim", "trace a wrong fact", "that's not true", "I never said that", "where did you get that", "you got that wrong", "root-cause this error" | yes | plugin |
| `cron-scheduler` | Put recurring work on a Memrain host the right way: pick between the background cycle, the built-in daemons, a host timer that submits a durable job, and a one-shot deferred job; stagger slots, respect quiet hours, ke... | "schedule a job", "cron", "quiet hours", "what jobs are running", "run this every night", "schedule recurring work", "pause the daemons" | yes | brain |
| `cross-modal-review` | Quality gate via second model. | "second opinion", "cross-modal review", "double check this", "get another perspective", "challenge this code", "adversarial review" | no | brain, prompt |
| `daily-task-manager` | Keep the user's running task list as one brain page with stable task ids: add, complete, defer, remove and review tasks, with deterministic action routing, version-checked edits and no guessing when a request matches ... | "add task", "complete task", "what are my tasks", "task list", "defer task", "remove task", "mark the task done", "add to my todo list" | yes | brain |
| `daily-task-prep` | Morning preparation. | "morning prep", "prepare for today", "what's on my plate", "day prep" | no | brain, prompt |
| `data-loss-gate` | Confirmation gate before any operation that can lose brain data: forgetting facts, deleting or purging pages, reverting with force, stripping page content, bulk retypes, host-side erasure, and shell or raw-SQL deletio... | "review data loss", "confirm bulk deletion", "bulk delete", "bulk forget", "forget these facts", "purge the deleted pages", "wipe the brain", "is this deletion reversible", "rm -rf", "truncate the table", "drop the table", "free up disk space", "delete the docker volume" | yes | brain |
| `data-research` | Structured data research: search sources, extract structured data, archive raw sources, maintain canonical tracker pages, deduplicate. | "research", "track", "extract from email", "investor updates", "donations", "build a tracker", "data dig" | yes | brain |
| `db-repair` | Diagnose why the brain's database cannot be reached (Postgres or PGLite) when a tool call fails with db_busy, db_timeout or storage_error, or the operator says the brain database is down. | "brain database is down", "cannot reach the brain database", "memrain database error", "memrain connection refused", "diagnose the brain database", "db_timeout", "storage_error" | no | operator only |
| `draft-in-voice` | Ghostwrite in a specific person's voice from a validated voice profile: posts, replies, launch copy, recruiting blurbs, emails. | "draft in voice", "write this as", "make this sound like", "ghostwrite", "draft a tweet as", "write a post as", "in their voice", "in my voice", "build a voice profile" | yes | plugin |
| `eiirp` | Everything In Its Right Place. | "everything in its right place", "eiirp", "store this research", "put this in the brain", "file this properly", "where does this research go", "make this permanent", "archive this research", "archive this research thread", "brain this", "file all of this", "organize all of this", "organize all of this work", "make this re-doable", "DRY this up", "check everything is in the right place" | yes | brain |
| `enrich` | Enrich brain pages with tiered enrichment protocol. | "enrich", "create person page", "update company page", "who is this person", "look up this company" | yes | brain |
| `fact-check` | Claim-by-claim verification of any content before it ships, in the manner of a professional fact-checking desk: extract every verifiable claim, check each against live citable sources (never model memory), give it one... | "fact check", "fact-check", "verify the facts", "check the claims", "is this accurate", "source check", "verify this output claim by claim", "is this output hallucinating", "re-derive every claim" | yes | plugin |
| `frontmatter-guard` | Validate and auto-repair YAML frontmatter on brain pages. | "validate frontmatter", "check frontmatter", "fix frontmatter", "frontmatter audit", "brain lint" | yes | brain |
| `functional-area-resolver` | Compress an agent's routing file (RESOLVER.md or AGENTS.md) by converting granular skill-per-row tables into functional-area dispatchers. | "compress agents.md", "compress my resolver", "resolver too big", "resolver.md too big", "agents.md too large", "shrink routing table", "slim down agents.md", "functional area resolver", "functional area dispatcher", "context-health agents", "context-health resolver", "reduce context budget" | yes | brain |
| `idea-ingest` | Ingest links, articles, tweets, and ideas into the brain. | "shares a link or URL", "read this", "save this", "think about this", "put this in brain" | yes | plugin |
| `idea-lineage` | Trace one idea's evolution through the brain: first mention, best articulation, related concepts, reversals, contradictions, abandoned branches, and the current live version. | "idea lineage", "trace the lineage of this idea", "how my thinking about", "how has my thinking about", "current version of this idea", "what is my current version of", "show reversals in my thinking about", "where did this idea come from" | no | brain |
| `ingest` | Route content to specialized ingestion skills. | "ingest this", "save this to brain", "add this to my brain" | yes | brain |
| `ingest-gate` | Check identity and duplicates before creating a brain page from new material. | "check before creating a page", "check ingest duplicates", "is this already in the brain" | yes | brain |
| `install` | Deprecated pointer. | "install" | no | operator only |
| `mail-loops` | Who is waiting on the user, and what the user is waiting on: replies owed, replies awaited, promises made, invitations not answered, across Gmail and Outlook mail and the Google and Outlook calendars. | "who is waiting on me", "what do i owe people", "open loops", "unanswered email", "unanswered invites", "connect gmail", "connect outlook", "connect my calendar", "memrain waiting" | yes | brain |
| `maintain` | Brain health checks: back-link enforcement, citation audit, filing validation, stale info detection, orphan pages, and benchmarks. | "check backlinks", "maintenance", "orphan pages", "stale pages", "extract links", "build link graph", "populate timeline", "populate links", "backfill graph", "extract timeline entries", "run the cycle", "process today's session", "process yesterday's transcripts", "synthesize my conversations", "what patterns did you see", "did the cycle run", "consolidate yesterday's conversations" | yes | brain |
| `mcp-access` | The owner's administration of who may use the brain over MCP: sign in to the admin panel, register OAuth clients and personal tokens, change a client's source or scopes, cut off tokens, revoke a client, and check who ... | "memrain admin login link", "open the admin panel", "manage mcp clients", "register an mcp client", "set up mcp oauth", "invalidate mcp tokens", "revoke an mcp client", "who can read this page", "change a client's access" | yes | operator only |
| `measure-before-you-fix` | Before fixing a slow, stale or timed-out alert, measure the blamed step yourself: kill the theory with a stopwatch, not a code change. | "keeps timing out", "etimedout", "why is this data stale", "freshness alert", "wedged", "job is slow", "sync is stuck", "raise the timeout" | no | brain |
| `media-ingest` | Ingest video, audio, PDF, book, screenshot, and GitHub repo content into the brain. | "watch this video", "process this YouTube link", "ingest this PDF", "save this podcast", "process this book", "PDF book", "summarize this book", "ingest it into my brain", "what's in this screenshot", "check out this repo" | yes | plugin |
| `meeting-ingestion` | Turn a meeting transcript into a verified meeting page with attendee enrichment, entity propagation and a timeline event on every participant. | "meeting transcript", "process this meeting", "meeting notes", "meeting recording", "meeting recorder", "audit this meeting", "meeting transcript received" | yes | plugin |
| `migrate` | Universal migration from Obsidian, Notion, Logseq, markdown, CSV, JSON, Roam | "migrate from", "import from obsidian", "import from notion" | yes | brain |
| `minion-orchestrator` | Background work on a Memrain host: durable server-side jobs of the kinds the brain registers, Memrain's own read-only agent jobs, and fan-out through the agent harness's subagents. | "jobs submit", "submit a job", "spawn agent", "background task", "run in background", "check on agent", "agent progress", "what's running", "cancel job", "retry job", "stop agent", "parallel tasks", "fan out", "do these in parallel", "long operation", "durable execution", "the job went silent" | yes | operator only |
| `perplexity-research` | Brain-augmented Perplexity research. | "Perplexity research", "perplexity-research", "perplexity", "what's new about", "current state of", "what changed about", "surface new developments" | yes | brain |
| `postgres-adopt` | Find out which engine a Memrain brain runs on (PGLite or Postgres), say when Postgres is worth it, and move a PGLite brain to Postgres with every table copied and verified (dry run, agree, copy, verify, switch). | "which memrain engine", "pglite or postgres", "memrain engine status", "upgrade to postgres", "switch memrain to postgres", "move my brain to postgres", "set up postgres for the brain" | yes | operator only |
| `publish` | Share brain pages as beautiful password-protected HTML with client-side encryption | "share this page", "publish page", "create shareable link" | no | brain |
| `query` | Answer questions using the brain's knowledge with 3-layer search, synthesis, and citation propagation. | "what do we know about", "tell me about", "who is", "what happened", "search for", "look up", "background on", "notes on", "who knows who", "relationship between", "connections", "graph query" | no | plugin, prompt |
| `remote-mcp` | Make the user's own Memrain reachable over MCP from their other devices, desktop apps and cloud agents, without moving the data or putting the database on the internet. | "use my brain over mcp", "serve my brain over mcp", "expose my brain over mcp", "remote mcp access to my brain", "reach my brain from my phone", "connect claude desktop to my brain", "connect claude.ai to my brain", "use my brain from another device", "put my brain online" | yes | operator only |
| `repo-architecture` | Where new brain pages go. | "where does this go", "filing rules", "create new page", "which directory" | no | brain |
| `reports` | Save and load timestamped reports as brain pages under reports/, find the latest one by category or keyword, and check every link in a report before it reaches the user. | "save report", "load latest report", "what's the latest briefing", "show me the pulse", "report quality", "link quality check", "validate report links" | yes | brain |
| `research-compendium` | Deep-research a topic end to end and leave a permanent knowledge asset: archive every primary source (as the user's retention posture allows), write one summary per source, then synthesise one self-contained compendiu... | "compendium", "research everything about", "read them all and summarize", "definitive guide", "comprehensive guide to", "deep research and write up", "archive the sources then summarize", "deepen the compendium" | yes | plugin |
| `resolve-before-asking` | Gate on identity questions to the user. | "resolve before asking", "before asking the user", "unidentified contact", "unknown relationship", "should i ask who", "don't know who this is", "to be filled by content analysis", "placeholder on this page" | yes | plugin |
| `schema-author` | Evolve the brain's type taxonomy. | "add a page type", "add a type to my taxonomy", "my brain has untyped pages", "types aren't matching my notes", "propose new types from my corpus", "backfill page types", "evolve my taxonomy", "extend the type conventions", "create a custom type for", "researcher type", "make X an expert type", "ontology propose", "taxonomy author" | no | brain |
| `schema-unify` | Collapse a brain's sprawl of page types (tweet, tweet-thread, tweet-single, x-post…) into a small canonical set, with the long tail kept recoverable. | "unify my types", "consolidate page types", "too many page types", "shrink type proliferation", "apply a canonical taxonomy", "clean up my page types", "retype pages to canonical" | yes | operator only |
| `setup` | Set up Memrain with provisioned Postgres (RDS + pgvector), AGENTS.md injection, first import | "set up memrain", "initialize brain", "memrain setup", "set up memex" | yes | brain |
| `share-audit` | Operator review of the pages a proposed team or pilot grant would expose, without quoting sensitive material. | "audit a proposed share", "review team exposure", "what would this grant expose" | no | brain |
| `signal-detector` | Always-on ambient signal capture. | "every inbound message (always-on)" | yes | brain |
| `skill-autobench` | Write a skill's routing benchmark from how it was really used, not from its spec. | "skill autobench", "autobench", "write the eval from usage history", "synthesize an eval for this skill", "mine how this skill is actually used", "build a benchmark from my corrections" | no | operator only |
| `skill-creator` | Create new skills following the Memrain conformance standard. | "create a skill", "new skill", "improve this skill" | yes | brain |
| `skill-optimizer` | Improve how reliably a skill gets picked, against its routing benchmark, with a paid but hard-capped evaluation. | "optimize this skill", "tune the skill against the benchmark", "make the skill route better", "run skillopt", "skillopt for" | no | operator only |
| `skillify` | Take a raw workflow, or an existing skill that needs a fix or a quality pass, through Memrain's skill checklist until it is a served, linted, routed, tested unit in deploy/skills. | "skillify this", "skillify", "is this a skill?", "make this proper", "add tests and evals for this", "check skill completeness", "take this skill through the checklist" | yes | brain |
| `skillpack-check` | Produce an agent-readable health verdict for the brain install from the doctor report (run_doctor over MCP, memrain doctor on the host), plus the status and per-source rollups, so a host agent (a morning-briefing run,... | "is the brain healthy", "brain health", "check the brain", "is the brain working", "health check" | no | brain |
| `skillpack-harvest` | Lift a proven skill from somewhere else (the user's own skills folder, a team's private pack, a public catalog) into Memrain's shipped pack in deploy/skills, so every brain and the plugin can serve it. | "harvest this skill", "harvest my skill", "lift this skill into the pack", "add this skill to memrain", "promote this skill", "promote my skill", "share this skill with the pack", "import a skill from a catalog" | no | operator only |
| `smoke-test` | Post-restart smoke tests + auto-fix for the Memrain server environment. | "smoke test", "run smoke tests", "container restart check", "did the restart break anything", "did the container restart break anything" | yes | brain |
| `soul-audit` | 6-phase interactive interview that generates the agent's identity (identity/soul), operator profile (identity/user), access posture (identity/access-policy), and operational cadence (identity/heartbeat) as brain pages. | "soul audit", "customize agent", "who am I", "set up identity", "change my agent's personality" | yes | brain |
| `strategic-reading` | Read a book, article, transcript, or case study through the lens of a specific strategic problem you're facing. | "strategic reading", "read this through the lens of", "apply this to my problem", "what can I learn from this about", "extract a playbook from" | yes | brain |
| `testing` | Skill validation framework PLUS daily test-suite health and regression intelligence. | "validate skills", "test skills", "skill health check", "run conformance tests", "run the tests", "how are the tests", "what's broken", "daily test run" | yes | brain |
| `two-tier-extraction` | Tiered model extraction for large corpora (mail archives, document dumps, transcript libraries). | "two-tier extraction", "triage then deep read", "smart model routing", "cheap triage expensive analysis", "model escalation pattern", "route models by content value", "which model tier for bulk extraction" | yes | brain |
| `voice-note-ingest` | Ingest a voice note with exact-phrasing preservation (never paraphrased). | "voice note", "ingest this voice memo", "transcribe and file", "voice note ingest", "save this audio note", "audio message" | yes | brain |
| `webhook-transforms` | Generic framework for converting external events (SMS, meetings, social mentions) into brain-ingestible signals. | "set up webhook", "process webhook event", "transform this event" | yes | brain |

Shared rules the skills defer to, each read with `get_skill <slug>`:

| Slug | Rule |
|---|---|
| `_AGENT_README` | Agent onboarding — what to do with the Memrain skill layer |
| `_brain-filing-rules` | Brain Filing Rules -- MANDATORY for all skills that write to the brain |
| `_friction-protocol` | Friction protocol — convention |
| `_output-rules` | Output Rules |
| `conventions/brain-first` | Brain-First Lookup Convention |
| `conventions/brain-routing` | Brain Routing Convention |
| `conventions/calibration` | Convention: calibration loop |
| `conventions/exec-output` | Exec Output Convention |
| `conventions/model-routing` | Model Routing Convention |
| `conventions/page-privacy` | Page Privacy Convention |
| `conventions/path-discipline` | Path Discipline Convention |
| `conventions/quality` | Quality Convention |
| `conventions/regex-discipline` | Regex Discipline Convention |
| `conventions/salience-and-recency` | Salience + Recency on brain queries |
| `conventions/scheduled-work` | Scheduled Work Convention |
| `conventions/schema-evolution` | Convention: schema evolution — when to add a type vs alias vs prefix |
| `conventions/search-modes` | How to pick the retrieval surface and knobs — search depth, detail level, date bounds, and when to escalate to entity_recall, relational_recall, or think. |
| `conventions/subagent-routing` | Subagent Routing Convention |
| `conventions/test-before-bulk` | Test Before Bulk Convention |
| `conventions/untrusted-content` | Untrusted Content Convention |

<!-- END GENERATED: skill table -->

## Disambiguation rules

When more than one skill fits:

1. The most specific skill wins: `meeting-ingestion` over `ingest`,
   `article-enrichment` over `enrich`. A generic "ingest this" with the type
   unclear goes to `ingest`, which routes on.
2. Route a URL by what it points at: one article, essay or tweet →
   `idea-ingest`; a whole blog, feed or newsletter archive → `blog-ingest`;
   video, audio, podcast, PDF, book, screenshot or repository →
   `media-ingest`; a quick thought kept without fetching → `capture`.
3. Chat history: an export file, a pushed session log or a question over the
   archive → `conversation-archive`; a connected account that keeps syncing →
   `chat-connectors`.
4. A claim the user says is wrong in the brain → `correction-pipeline`; a
   draft checked before it ships → `fact-check`; how a true claim is cited →
   `citation-fixer`.
5. Anything that can lose brain data (forget without a replacement, bulk
   delete, purge, bulk retype) passes `data-loss-gate` first, whichever skill
   started it.
6. What the identity pages should say → `soul-audit`; how many tokens the
   always-loaded context costs → `context-audit`.
7. How the brain is reached from other devices → `remote-mcp`; who may use it
   (admin panel, clients, tokens, revocation) → `mcp-access`; configuring one
   client from its guide → `connect-client`; what a proposed grant would
   expose → `share-audit`.
8. "Why is this slow or stale" → `measure-before-you-fix` first; health checks
   and repairs → `maintain`; "is it up after a restart" → `smoke-test`.
9. Still unsure: ask, with the choice gate in `ask-user`.
