// Plain-language help for every figure in the panel, and the glossary it links
// to. Each help entry names one glossary term.

interface Help { label: string; text: string; term: string }

export const METRIC_HELP = {
  "tile.health": {
    label: "Health",
    text: "Whether new text is searchable yet. 100% means everything saved can be found by meaning; code and pages marked to skip are left out. Below 99%, new text is still being processed or processing failed. Chunks: passages processed out of those that should be. Last write: time since anything changed. Queue depth: background jobs waiting. Failed jobs: failures in the last 24 hours.",
    term: "embedding",
  },
  "tile.traffic": {
    label: "Traffic",
    text: "Requests: tool calls from agents in the last 24 hours, not counting this panel or the MCP handshake. The line under the figure is the 7-day trend. Error rate: share of those calls that failed. Top agents: credentials with the most calls since the server's local midnight.",
    term: "tool-call",
  },
  "tile.spend": {
    label: "Spend",
    text: "Estimated model cost in the last 24 hours and 7 days, from the server's cost record; refused calls cost nothing. The line under the figure is the 7-day trend. Top model: the model that cost the most over 7 days. Nearest cap: the agent closest to its daily cap today (UTC); at 100% its paid calls are refused until midnight UTC.",
    term: "spend",
  },
  "tile.jobs": {
    label: "Jobs",
    text: "Running and queued background jobs. Failed: failed jobs still on record (old jobs are pruned, so this is not a lifetime total). Last failure: the most recent failed job; open it on the Jobs page to read its error.",
    term: "job",
  },
  "corpus.pages": { label: "Pages", text: "Live pages: notes and documents not deleted.", term: "page" },
  "corpus.documents": { label: "Documents", text: "Live indexed documents: pages and other sources the search index holds.", term: "document" },
  "corpus.chunks": { label: "Chunks", text: "All passages the documents are split into for search.", term: "chunk" },
  "corpus.facts": { label: "Facts", text: "Short claims, extracted from pages or recorded directly, that have not been forgotten.", term: "fact" },
  "corpus.entities": { label: "Entities", text: "Distinct subjects with at least one live fact.", term: "entity" },
  "corpus.links": { label: "Links", text: "All stored links between pages, including links to pages that do not exist yet.", term: "link" },
  "chart.activity": {
    label: "Activity",
    text: "Agent tool calls and failures per UTC day. The headline compares with the same length of time just before, cut at the same time of day.",
    term: "tool-call",
  },
  "chart.spend": {
    label: "Estimated model cost",
    text: "Daily estimated cost per model (UTC days). The dashed line is the brain's current daily cap; once a day reaches it, further paid calls are refused until midnight UTC. Calls with no known price are counted, not priced at zero.",
    term: "daily-cap",
  },
  "chart.content": {
    label: "New content",
    text: "Pages created, page edits and facts added per UTC day. Deleting or restoring a page is not an edit.",
    term: "page",
  },
  "chart.searches": {
    label: "Searches (all sources)",
    text: "Searches per UTC day from agents, the command line and the brain's own background tasks. Panel searches are not counted. Recent searches may take a minute to appear.",
    term: "search",
  },
  "chart.top_tools": { label: "Top tools", text: "The tools agents called most in the selected range, with failures.", term: "tool-call" },
  "chart.agents": { label: "Who uses the brain", text: "Calls per credential in the selected range.", term: "agent" },
  "section.spend_by_feature": {
    label: "Spend by model and operation",
    text: "Estimated cost over the last 7 days from the server's cost record, split by model and by the feature that made the call.",
    term: "spend",
  },
  "section.caps": {
    label: "Daily caps",
    text: "Each OAuth client's daily spending cap and how much of it is used today (UTC), including calls still in flight.",
    term: "daily-cap",
  },
  "section.build": {
    label: "Build",
    text: "The running server's version, start time and health flags, as its /health check reports them.",
    term: "mcp",
  },
  "graph.linked": {
    label: "Linked pages",
    text: "Pages with at least one link to or from another live page. Links to pages that do not exist are not counted here.",
    term: "link",
  },
  "graph.degree": { label: "Links", text: "Links between this page and other live pages, counting both directions.", term: "hub" },
} as const satisfies Record<string, Help>;

export type MetricId = keyof typeof METRIC_HELP;

export interface GlossaryTerm { id: string; term: string; text: string; see?: string[] }

export const GLOSSARY: readonly GlossaryTerm[] = [
  { id: "brain", term: "Brain", text: "This memory server: the pages, facts and links your agents read and write, shared across every session and every connected app.", see: ["page", "fact", "agent"] },
  { id: "agent", term: "Agent", text: "An AI app or script that uses the brain, such as Claude Code, claude.ai or ChatGPT. Each one connects with its own credential, so its calls can be told apart.", see: ["credential", "mcp"] },
  { id: "credential", term: "Credential", text: "What an agent shows to reach the brain: a personal access token for a command-line tool, or an OAuth client for apps that sign in through the browser. Manage them on the Agents page.", see: ["agent"] },
  { id: "mcp", term: "MCP", text: "Model Context Protocol, the standard way AI apps call tools on a server. The brain offers its tools over MCP at one address, ending in /mcp.", see: ["tool-call"] },
  { id: "tool-call", term: "Tool call", text: "One request from an agent to one of the brain's tools, such as search or page_put. The MCP handshake and this panel's own requests are not counted.", see: ["mcp"] },
  { id: "page", term: "Page", text: "One note or document in the brain, addressed by a slug such as people/alice. Every edit keeps the earlier version.", see: ["document", "link"] },
  { id: "document", term: "Document", text: "Anything the search index holds: pages and other imported sources.", see: ["chunk"] },
  { id: "chunk", term: "Chunk", text: "A passage of a document. Search ranks chunks, then shows the page each one came from.", see: ["embedding"] },
  { id: "embedding", term: "Embedding", text: "A list of numbers that captures what a passage means, so search can find it by meaning and not only by its words. Computing one costs a small model call.", see: ["chunk", "search"] },
  { id: "search", term: "Search", text: "A query against the brain that ranks passages by meaning and by keywords. Agents, the command line and the brain's own background tasks all search.", see: ["embedding"] },
  { id: "fact", term: "Fact", text: "A short claim, such as 'Alice leads the launch project', with its date. Most facts are extracted from a page and point back to it; an agent can also record one directly. A fact can be superseded by a newer one or forgotten.", see: ["entity"] },
  { id: "entity", term: "Entity", text: "Something the brain knows facts about: a person, company, project or topic.", see: ["fact"] },
  { id: "link", term: "Link", text: "A connection from one page to another, made by a [[wikilink]] in the page text or by an agent with the link tool. A link can point at a page that does not exist yet.", see: ["hub"] },
  { id: "hub", term: "Hub", text: "A page with many links to and from other pages. The Graph starts at the most connected ones.", see: ["link"] },
  { id: "job", term: "Job", text: "Background work the server runs on its own, such as embedding new text or nightly maintenance. Failed jobs keep their error so you can see what went wrong.", see: ["embedding"] },
  { id: "spend", term: "Spend", text: "Estimated money paid to the AI model provider, recorded per call by the server from configured prices.", see: ["daily-cap"] },
  { id: "daily-cap", term: "Daily cap", text: "A spending limit per UTC day for the whole brain or for one agent. Paid calls that would pass it are refused until the next day.", see: ["spend"] },
  { id: "time-window", term: "Time window", text: "Charts use UTC days. Tiles use the last 24 hours, except where the label says otherwise." },
];
