/**
 * The write gate's pattern table: text that reads as instructions to an AI
 * rather than as content. Each entry runs over one of two normalized views
 * built by write-gate.ts:
 *
 *   prose       lower-cased, NFKC, invisible characters removed, punctuation
 *               turned into spaces, spaced-out letters joined, look-alike
 *               letters folded to the word's majority script, digits in
 *               mixed words read as letters; one space between words.
 *   structural  lower-cased, NFKC, invisible characters removed, line breaks
 *               unified to "\n", punctuation kept (markup, JSON, URLs).
 *   sentence    the structural view with emphasis marks removed, runs of
 *               spaces and tabs made one space, spaced-out letters joined and
 *               look-alike letters folded as in the prose view: punctuation,
 *               addresses and sentence ends stay readable.
 *
 * A `seq` entry matches when its parts appear in order inside one line or
 * sentence of the structural view, so a "verb … object … destination"
 * check costs one linear pass per part instead of a nested backtrack.
 *
 * A `preceded` entry counts a match only where its `$`-anchored context regex
 * matches the text just before it (at most MAX_PRECEDING_CHARS) and the
 * context's optional `neg` group did not take part, so a pattern can start at
 * its rare token (an address, "from now on", a credential noun) instead of a
 * common verb. Every match is tried, so padding the text with rejected
 * matches cannot hide a real one.
 *
 * Every gap is bounded and every repeated group is delimited, so each pattern
 * is linear in its input; the cost test in write_gate_detector.test.ts holds
 * that through the real detector. Bump WRITE_GATE_DETECTOR_VERSION in
 * write-gate.ts whenever this table changes.
 */

export type GateFamily =
  | "ai_directive"
  | "role_spoof"
  | "tool_call_shape"
  | "exfiltration"
  | "memory_poisoning"
  | "standing_instruction"
  | "credential";

export type GateView = "prose" | "structural" | "sentence";

export interface GatePattern {
  name: string;
  family: GateFamily;
  view: GateView;
  /** One regex, or (structural view only) parts that must follow each other within a line or sentence. */
  re?: RegExp;
  seq?: readonly RegExp[];
  /** Context the text before a match must end with (sentence view; see above). */
  preceded?: RegExp;
  /** Cheap gates: the pattern runs only on text each of these also matches somewhere. */
  requires?: readonly RegExp[];
  /** A cheap gate on the text before a match, tried before `preceded`. */
  near?: RegExp;
}

/** Longest context a `preceded` regex reads before a match. */
export const MAX_PRECEDING_CHARS = 260;

// Word boundaries that also hold for Cyrillic (`\b` is ASCII-only). The prose
// view is padded and single-spaced, so a word starts after a literal space; a
// leading literal is far cheaper to scan for than a leading lookbehind.
const P = " ";
const S = "(?:^|[^\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}])";
/** Up to `n` whole words in the prose view, where words are single-space separated. */
const gap = (n: number) => `(?:[^ ]+ ){0,${n}}?`;
const re = (source: string) => new RegExp(source, "u");

const BRAIN_WRITE_TOOLS =
  "page_put|page_delete|page_edit|page_append|page_rename|page_revert|page_restore|add_fact|forget_fact|"
  + "extract_facts|put_raw_data|takes_add|takes_update|takes_resolve|set_take_status|add_tag|remove_tag|"
  + "add_timeline_event|log_ingest";


/**
 * Literal spaces in a sentence-view source become `\s{1,4}` (and ` ?` becomes
 * `\s{0,4}`), so a doubled space or a hard-wrapped line cannot split a
 * phrase; escapes and character classes are copied verbatim.
 */
export function spaced(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") { out += source.slice(i, i + 2); i++; continue; }
    if (ch === "[") {
      let j = i + 1;
      while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch !== " ") { out += ch; continue; }
    if (source[i + 1] === "?") { out += "\\s{0,4}"; i++; } else out += "\\s{1,4}";
  }
  return out;
}

/** A sentence-view pattern; `preceded` is anchored at the match. */
function sentence(name: string, family: GateFamily, source: string, extra: { preceded?: string; requires?: readonly string[]; near?: string } = {}): GatePattern {
  return {
    name,
    family,
    view: "sentence",
    re: new RegExp(spaced(source), "i"),
    ...(extra.preceded ? { preceded: new RegExp(`${spaced(extra.preceded)}$`, "i") } : {}),
    ...(extra.requires ? { requires: extra.requires.map(r => new RegExp(spaced(r), "i")) } : {}),
    ...(extra.near ? { near: new RegExp(spaced(extra.near), "i") } : {}),
  };
}

/** One character inside a sentence. */
const SENT = "[^.!?]";
/** One character inside a clause: also stops at a table cell boundary. */
const CLAUSE = "[^.!?|]";
/**
 * One character inside a sentence for a `preceded` context: `.`, `!` or `?`
 * ends the sentence only before whitespace, so an address, a URL or "3.5"
 * earlier in the sentence does not cut the context short.
 */
const CTX = "(?:[^.!?]|[.!?](?=\\S))";
/** Past participles of the send-it-there verbs, for passive rules ("must be emailed to ..."). */
const PASSIVE_EXFIL = "(?:forwarded|sent|emailed|e-mailed|mailed|cc[’']?d|cced|bcc[’']?d|copied|posted|uploaded|transferred|wired|shared|leaked|synced|mirrored|reported|submitted|routed|rerouted|redirected|exported|remitted|delivered)";
/** "to <address>", allowing a few words before it ("to the portal at https://..."), or "shared with <address>". */
const TO_ADDRESS_HEAD = "\\b(?:to|with)(?: ?: ?| )(?:[a-z-]{1,20} ){0,5}";
const FUTURE = "(?:from now on|going forward|henceforth|from this point (?:on|forward)|in (?:all )?future (?:answers|responses|replies|conversations|sessions|chats))";
const AGENT = "(?:ai assistant|assistant|chatbot|ai agent|agent|llm|claude|chatgpt|gpt|gemini|copilot|grok|bot|ai)";
/** "the AI team", "the assistant manager": a person or a thing, not the agent addressed. */
const NOT_COMPOUND = "(?! (?:team|teams|lab|labs|group|department|engineers?|researchers?|leads?|managers?|startup|company|companies|vendors?|products?|projects?|strategy|policy|act|regulation|initiative|budget|tools?|models?)\\b)";
/** In a vocative ("instructions for the model:") "model" addresses the agent too. */
const AGENT_V = "(?:ai assistant|assistant|chatbot|ai agent|agent|llm|claude|chatgpt|gpt|gemini|copilot|grok|bot|ai|(?:language )?model)";
const SPEECH = "(?:say|tell|respond|reply|answer|recommend|mention|claim|state|describe|refer|suggest|output|report|deny|confirm|praise|promote|call|treat|use|ignore|include)";
const ACTION = "(?:forward|send|email|e-mail|cc|bcc|share|reveal|upload|post|transfer|wire|pay|delete|remove|run|execute|invoke|book|buy|approve|grant|disclose)";
const STRICT_SPEECH = "(?:say|tell|respond|reply|answer|recommend|mention|claim|state|deny|reveal|disclose|describe|suggest|output)";
const EXFIL_VERB = "(?<![.@])(?:forward|send|email|e-mail|cc|bcc|copy|post|upload|transfer|wire|share|leak|exfiltrate|sync|mirror|report|submit|route|reroute|redirect|export|remit|deliver|"
  + PASSIVE_EXFIL + ")";
const STANDING = "(?:always|from now on|going forward|moving forward|henceforth|whenever|every time|automatically|silently|secretly|quietly|without (?:telling|notifying|asking)|all future|any future|every future|in (?:the )?future|effective immediately|until further notice|from this point(?: on| forward)?|new (?:policy|rule|procedure|process))";
/** A standing word not describing what already happens ("automatically forwarded to", "always sent to"). */
const STANDING_RULE = `\\b${STANDING}\\b(?! ${PASSIVE_EXFIL}\\b)`;
/** An email address (whole host), or a URL / www host. */
const ADDRESS = `(?:[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,30}${"(?:\\.[a-z0-9-]{1,30})?".repeat(3)}\\.[a-z]{2,24}|(?:https?:\\/\\/|www\\.)[^\\s<>"']{1,120})`;
const CREDENTIAL = "(?:api[ _-]?keys?|passwords?|passphrases?|credentials?|secret keys?|access tokens?|auth(?:entication)? tokens?|bearer tokens?|refresh tokens?|private keys?|ssh keys?|seed phrases?|recovery (?:codes?|phrases?)|2fa codes?|one-time (?:codes?|passwords?)|session (?:cookies?|tokens?)|\\.env files?)";
/** Present in any text an address pattern can match. */
const HAS_ADDRESS = "@|https?:\\/\\/|www\\.";
/** What may open an address in mail: a bracket or quote, or "mailto:". */
const ADDR_OPEN = "(?:mailto: ?)?[<(\\[\"']? ?";
/** "tell" asks for a credential only with a person after it ("tell me your password"), not in "tell the agent which credentials". */
const CREDENTIAL_VERB = "(?:send(?: over)?|email|e-mail|share|reveal|paste|give|forward|upload|disclose|leak|dump|exfiltrate|tell(?= (?:me|us|them) )|provide|submit|reply with)";
const PRIVATE_DATA = `(?:memor(?:y|ies)|conversation history|chat history|system prompt|private notes|user data|${CREDENTIAL})`;
const MODAL = "(?:always|never|must|should|do not|don't|from now on|going forward)";

export const WRITE_GATE_PATTERNS: readonly GatePattern[] = Object.freeze([
  // --- Directives addressed to an AI ---------------------------------------
  {
    name: "ignore_prior_instructions",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:ignore|disregard|forget|override|overrule|bypass|discard|abandon) ${gap(4)}`
      + `(?:previous|prior|above|earlier|preceding|initial|original|existing|current|system|safety|developer|all|any|your|these)${E} ${gap(3)}`
      + `(?:instructions?|prompts?|guardrails|programming|directives?|guidelines|rules|constraints|polic(?:y|ies)|context)${E}`),
  },
  {
    name: "ignore_instructions_above",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:ignore|disregard|forget|override|bypass) (?:all |any )?(?:of )?(?:the |your |these |those )?`
      + `(?:instructions?|prompts?|directives?|guidelines|rules|context) (?:above|before this|so far|you were given|you have been given)${E}`),
  },
  {
    name: "ignore_prior_instructions_ru",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:проигнорируй|игнорируй|игнорируйте|забудь|забудьте|отмени|отмените|отбрось|не обращай(?:те)? внимания на) ${gap(3)}`
      + `(?:предыдущ|прошл|прежн|все|вс[её]|системн|исходн|ранее|выше)[^ ]* ${gap(2)}`
      + `(?:инструкц|указани|правил|промпт|ограничени|директив)`),
  },
  {
    name: "role_reassignment",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}you are now (?:an? |the |my )?(?:dan|jailbroken|unrestricted|unfiltered|uncensored|evil|no longer bound|(?:[^ ]+ )?(?:ai|assistant|model|bot|agent) (?:with|without|that))${E}`),
  },
  {
    name: "from_now_on_obey",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}from (?:now on|this point(?: on| forward)?) you (?:must|will|shall|should|only|are to) ${gap(2)}(?:ignore|disregard|obey|answer|respond|reply|comply|follow)${E}`),
  },
  {
    name: "now_you_serve_ru",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}теперь ты (?:работаешь|подчиняешься|слушаешься|отвечаешь|будешь)${E}`),
  },
  {
    name: "jailbreak_terms",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:jailbreak|jailbroken|dan mode|do anything now|(?:enable|activate|enter|switch to|turn on) (?:the )?developer mode)${E}`),
  },
  {
    name: "addressed_to_ai",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:(?:note|message|instructions?|attention|notice|reminder) (?:to|for) (?:the |any |all )?(?:ai|llm|language model|chatbot|ai assistant|ai agent|automated assistant|virtual assistant)`
      + `|if you are (?:an? )?(?:ai|llm|large language model|language model|ai assistant|chatbot|automated (?:system|agent|assistant))`
      + `|(?:dear|hey|hello|hi) (?:ai|llm|chatbot|ai assistant|language model))${E}`),
  },
  {
    name: "addressed_to_ai_ru",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:вниманию|к сведению|сообщение для|инструкция для|если ты) (?:[^ ]+ )?(?:(?:ии|ai)(?:${E}|-)|ассистент|нейросет|чат-бот|языков[^ ]* модел)`),
  },
  {
    name: "vocative_command",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:assistant|chatbot|ai assistant|ai agent) (?:please )?(?:ignore|override|disregard|forget|call|execute|delete|remember)${E}`),
  },
  {
    name: "keep_from_owner",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:(?:do not|don't|dont|never) (?:tell|inform|notify|alert|warn|let) (?:the )?(?:user|owner|human|operator)`
      + `|without (?:telling|informing|notifying|alerting) (?:the )?(?:user|owner|human|operator))${E}`),
  },
  {
    name: "keep_from_owner_ru",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}не (?:говори|сообщай|рассказывай|показывай)(?:те)? (?:об этом )?(?:пользовател|владельц|человек|хозя)`),
  },

  // --- Chat-template and role markers ---------------------------------------
  {
    name: "chat_template_token",
    family: "role_spoof",
    view: "structural",
    re: re(`<\\|\\s{0,3}(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\\s{0,3}\\|>`),
  },
  {
    name: "role_tag",
    family: "role_spoof",
    view: "structural",
    re: re(`<\\s{0,3}\\/?\\s{0,3}(?:system|sys|instructions?|system_prompt|developer)\\s{0,3}>`),
  },
  {
    name: "bracket_role",
    family: "role_spoof",
    view: "structural",
    re: re(`\\[\\s{0,3}\\/?\\s{0,3}(?:inst|sys|system|system prompt)\\s{0,3}\\]`),
  },
  {
    name: "role_heading",
    family: "role_spoof",
    view: "structural",
    re: re(`(?:^|\\n)[ \\t]{0,3}#{1,6}[ \\t]{0,3}(?:system|assistant|developer)(?: prompt| message| instructions?)?[ \\t]{0,3}:?[ \\t]{0,3}(?:\\n|$)`),
  },
  {
    name: "role_line",
    family: "role_spoof",
    view: "structural",
    re: re(`(?:^|\\n)[ \\t]{0,3}(?:system|assistant)[ \\t]{0,3}:[ \\t]{0,3}(?:you |ignore|disregard|new (?:instructions|rules|policy)|from now on|override)`),
  },
  {
    name: "override_label",
    family: "role_spoof",
    view: "structural",
    re: re(`${S}(?:system|developer|admin)[ \\t]{0,3}(?:override|prompt|instructions?)[ \\t]{0,3}:`),
  },

  // --- Text shaped like a tool call -----------------------------------------
  {
    name: "tool_markup",
    family: "tool_call_shape",
    view: "structural",
    re: re(`<\\s{0,3}\\/?\\s{0,3}(?:function_calls|invoke|tool_use|tool_call|tool_calls|function_call|tool_result)${E}`),
  },
  {
    name: "tool_json",
    family: "tool_call_shape",
    view: "structural",
    re: re(`"(?:tool|tool_name|function|name|recipient_name)"\\s{0,5}:\\s{0,5}"[^"\\n]{1,100}"\\s{0,5},\\s{0,5}"(?:arguments|args|parameters|input|params)"\\s{0,5}:\\s{0,5}[{["]`),
  },
  {
    name: "tool_json_key",
    family: "tool_call_shape",
    view: "structural",
    re: re(`"(?:tool_calls|function_call|tool_use|tool_choice)"\\s{0,5}:|"method"\\s{0,5}:\\s{0,5}"tools\\/call"`),
  },
  {
    name: "brain_tool_call",
    family: "tool_call_shape",
    view: "structural",
    re: re(`${S}(?:${BRAIN_WRITE_TOOLS})\\s{0,3}\\(`),
  },
  {
    name: "invoke_named_tool",
    family: "tool_call_shape",
    view: "structural",
    re: re(`${S}(?:call|invoke|use|run|execute|trigger)[ \\t]{1,3}(?:the[ \\t]{1,3})?(?:(?:mcp[ \\t]{1,3})?(?:tool|function)[ \\t]{1,3}[\`'"]?[a-z][a-z0-9]*[_.][a-z0-9_.]{1,60}|[\`'"]?(?:${BRAIN_WRITE_TOOLS})${E})`),
  },
  {
    name: "function_namespace_call",
    family: "tool_call_shape",
    view: "structural",
    re: re(`${S}functions\\.[a-z_][a-z0-9_]{2,60}\\s{0,3}\\(`),
  },

  // --- Requests to move data out --------------------------------------------
  {
    name: "exfiltrate_ai_context",
    family: "exfiltration",
    view: "prose",
    re: re(`${P}(?:send|forward|email|post|upload|transmit|leak|exfiltrate|share|copy|include|append|output|print|reveal|dump|show|give|перешли|отправь|вышли|покажи|раскрой)(?:те)? ${gap(6)}`
      + `(?:(?:your |the )?system prompt|your (?:hidden |initial |original |system )?instructions|the (?:hidden|initial|original|system) instructions`
      + `|your (?:memory|memories)|contents of (?:your|the assistant's) memory|(?:the )?(?:full |whole |entire )?(?:chat|conversation) history|this conversation`
      + `|all (?:of )?(?:the )?(?:user's|owner's) (?:notes|pages|memories|facts|files|emails|data)|everything you know`
      + `|системн[^ ]* промпт|истори[^ ]* (?:чата|переписки)|все заметки|всю переписку)${E}`),
  },
  {
    name: "secret_to_url",
    family: "exfiltration",
    view: "structural",
    seq: [
      re(`${S}(?:send|forward|post|upload|transmit|leak|exfiltrate|append|attach|add|put|encode|paste)${E}`),
      re(`${S}(?:passwords?|api[ _-]?keys?|access[ _-]?tokens?|secret[ _-]?keys?|secrets|credentials|private[ _-]?keys?|ssh[ _-]?keys?|session[ _-]?cookies?|tokens)${E}`),
      re(`https?:\\/\\/|${S}(?:webhook|ngrok|requestbin|pastebin)`),
    ],
  },
  {
    name: "image_beacon",
    family: "exfiltration",
    view: "structural",
    seq: [
      re(`!\\[[^\\]\\n]{0,200}\\]\\(\\s{0,5}https?:\\/\\/`),
      re(`[?&][\\w.-]{1,40}=(?:\\{|%7b|\\$\\{|<)`),
    ],
  },

  // --- Directives to the memory itself ----------------------------------------
  {
    name: "remember_as_fact",
    family: "memory_poisoning",
    view: "prose",
    re: re(`${P}(?:remember|store|save|record|memorize|memorise|keep) (?:this|that|the following) (?:[^ ]+ )?`
      + `(?:as (?:an? )?(?:permanent |new |true |verified )?(?:fact|truth|rule|instruction)s?|permanently|forever|in (?:your|the assistant's) (?:long-term )?memory)${E}`),
  },
  {
    name: "rewrite_memory",
    family: "memory_poisoning",
    view: "prose",
    re: re(`${P}(?:update|overwrite|modify|edit|change|rewrite|wipe|clear) (?:your|the assistant's|the ai's) (?:memory|memories|instructions|system prompt|rules|knowledge base|notes)${E}`),
  },
  {
    name: "add_to_memory",
    family: "memory_poisoning",
    view: "prose",
    re: re(`${P}(?:add|write|insert|create|store|save)(?: an?| the)?(?: new)? (?:fact|memory|rule|entry|note) (?:to|in|into) (?:your|the assistant's) (?:memory|brain|knowledge base|notes)${E}`),
  },
  {
    name: "memory_directive_ru",
    family: "memory_poisoning",
    view: "prose",
    re: re(`${P}(?:(?:запомни|сохрани|запиши)(?:те)? (?:это |что )?(?:как (?:факт|правило|истину)|навсегда|в (?:свою |твою )?память)`
      + `|(?:обнови|измени|перепиши|очисти)(?:те)? (?:свою|свои|твою|твои) (?:память|инструкц|правила|системн))`),
  },

  // --- Overrides read at sentence level -------------------------------------
  sentence("forget_everything", "ai_directive", "\\bforget (?:everything|all (?:of )?the above)\\b"),
  sentence("new_instructions_label", "ai_directive", "\\b(?:new|updated|revised) instructions?:"),
  sentence("system_label_directive", "ai_directive", "\\bsystem ?: ?(?:you are|you must|never|always)\\b"),
  sentence("act_now", "ai_directive", "\\byou (?:must|should) now (?:act|behave|respond)\\b"),
  sentence("new_system_prompt", "ai_directive", "\\bnew system prompt\\b"),
  sentence("conceal_from_user", "ai_directive",
    "\\b(?:do not|don't|never)\\b (?:tell|inform|notify|alert|warn|mention (?:this |it )?to|reveal (?:this |it )?to) (?:the )?(?:user|owner|human|operator)\\b"),
  sentence("conceal_standing_action", "ai_directive",
    "\\b(?:never|do not|don't) (?:mention|tell|reveal|disclose|inform|notify|alert|flag) (?:(?:it|this|that|them) (?:to )?)?(?:the user|the owner|the human|me|it|this|that|them)\\b",
    { preceded: `\\b${STANDING}\\b${CTX}{0,160}` }),

  // --- Standing rules addressed to an agent -----------------------------------
  sentence("act_without_asking", "standing_instruction",
    "\\bwithout (?:asking|checking(?: with)?|confirming(?: with)?|consulting|telling|notifying|alerting|informing) (?:the user|the owner|the human|me|anyone|anybody|first)\\b",
    { preceded: `\\b${STANDING}\\b${CTX}{0,160}` }),
  sentence("from_now_on_lead", "standing_instruction",
    `\\b${FUTURE}\\b${SENT}{0,100}\\b(?:${SPEECH}|${ACTION}|(?:is|are|must|should|shall|will) (?:to )?be (?:called|referred to|described|treated|considered|known|listed|presented|named|introduced))\\b`),
  sentence("from_now_on_trail", "standing_instruction", `\\b${FUTURE}\\b`, { preceded: `\\b(?:${SPEECH}|${ACTION})\\b${CTX}{0,100}` }),
  sentence("agent_vocative_note", "standing_instruction",
    `\\b(?:(?:note|message|reminder|instructions?|attention|attn|memo) (?:to|for) (?:the |any |all |my |our |your )?(?:ai |llm )?|(?:dear|hey|hello|attention|attn) (?:the )?)${AGENT_V}\\b(?:${CLAUSE}{0,200}\\b${MODAL}\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})| ?[:,] ?(?:please )?(?:always |never |only )?(?:${SPEECH}|${ACTION}))\\b`),
  sentence("agent_vocative_any", "standing_instruction",
    `\\b(?:to|for) (?:any|all|every) (?:ai |llm )?${AGENT_V}s? (?:reading|seeing|processing|handling|that reads|who reads)\\b${CLAUSE}{0,200}\\b${MODAL}\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})\\b`),
  sentence("agent_standing_rule", "standing_instruction",
    `\\b${AGENT}\\b${NOT_COMPOUND}(?: ?(?:,${CLAUSE}{0,200}|:(?:[^*.!?|]${CLAUSE}{0,199}|))\\b${MODAL}\\b${SENT}{0,40}\\b(?:${SPEECH}|${ACTION})|${SENT}{0,40}\\b(?:always|never|from now on|going forward|henceforth)\\b${SENT}{0,40}\\b(?:${STRICT_SPEECH}|${ACTION})| (?:is|are|will be|shall be) (?:instructed |required |expected |supposed )?to (?:always |never |only )?(?:${SPEECH}|${ACTION}))\\b`),
  sentence("you_always_say", "standing_instruction", `\\byou\\b${SENT}{0,30}\\b(?:always|never)\\b${SENT}{0,40}\\b${STRICT_SPEECH}\\b`),
  sentence("imperative_always_say", "standing_instruction", `\\b(?:always|never) ${STRICT_SPEECH}\\b`, { preceded: "(?:[.!?:;\\n] ?|- )(?:please )?" }),
  sentence("when_asked_say", "standing_instruction",
    `\\b(?:asks?|asked|asking|inquires?|wants to know|comes? up|is brought up)\\b${SENT}{0,80}\\b(?:say|tell|respond|reply|answer|response|claim|state|insist|deny|recommend)\\b`,
    { preceded: `\\b(?:when|whenever|if)\\b${CTX}{0,60}` }),

  // --- Standing rules that route data to an address ---------------------------
  sentence("exfil_standing_lead", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `${STANDING_RULE}${CTX}{0,80}\\b${EXFIL_VERB}\\b${CTX}{0,80}`, requires: [HAS_ADDRESS, `\\b${STANDING}\\b`], near: `\\b${STANDING}\\b` }),
  sentence("exfil_standing_trail", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}${SENT}{0,80}\\b${STANDING}\\b`,
    { preceded: `\\b${EXFIL_VERB}\\b${CTX}{0,80}` }),
  sentence("exfil_agent_addressed", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `\\b${AGENT}\\b${NOT_COMPOUND}${CTX}{0,60}\\b${EXFIL_VERB}\\b${CTX}{0,80}`, requires: [HAS_ADDRESS, `\\b${AGENT}\\b`], near: `\\b${AGENT}\\b` }),
  sentence("exfil_private_data", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `\\b${EXFIL_VERB}\\b${CTX}{0,40}\\b${PRIVATE_DATA}\\b${CTX}{0,60}`, requires: [HAS_ADDRESS, `\\b${PRIVATE_DATA}\\b`], near: `\\b${PRIVATE_DATA}\\b` }),
  sentence("exfil_standing_direct", "exfiltration", `\\b(?:cc|bcc|copy|loop in|e-?mail) (?:in )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `${STANDING_RULE}${CTX}{0,80}`, requires: [HAS_ADDRESS, `\\b${STANDING}\\b`], near: `\\b${STANDING}\\b` }),
  sentence("exfil_passive_now", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `\\bnow (?:be|get|gets) (?:[a-z]{1,15} )?${PASSIVE_EXFIL}\\b${"(?: [a-z-]{1,15})?".repeat(2)} ?`, requires: [HAS_ADDRESS, "\\bnow\\b"], near: "\\bnow\\b" }),
  sentence("exfil_private_data_passive", "exfiltration", `${TO_ADDRESS_HEAD}(?:at |on |via )?${ADDR_OPEN}${ADDRESS}`,
    { preceded: `\\b${PRIVATE_DATA}\\b${CTX}{0,60}\\b(?:be|get|gets|got) (?:[a-z]{1,15} )?${PASSIVE_EXFIL}\\b${CTX}{0,20}`, requires: [HAS_ADDRESS, `\\b${PRIVATE_DATA}\\b`], near: `\\b${PRIVATE_DATA}\\b` }),
  // A bracket opens a placeholder only around a data word: "?id=[subscriber]" in a newsletter link is a mail template.
  sentence("exfil_templated_url", "exfiltration",
    "https?:\\/\\/[^\\s)\"'<>]{1,200}[?&][a-z0-9_]{1,30}= ?(?:\\{|<|%7b|\\$\\{|\\[ ?(?:memor(?:y|ies)|data|secrets?|context|history|conversation|chat|user|passwords?|tokens?|keys?|notes?|prompt|system|instructions?))"),

  // --- Requests to hand over credentials ---------------------------------------
  sentence("credential_request", "credential", `\\b${CREDENTIAL}\\b`, {
    // A negation counts only right before the verb ("never send", "do not share"), or across "ever" and an asking verb
    // ("will never ask you to send"); "I'm not at my desk so send me your password" is still a request. Not after
    // "why", and not in "don't hesitate / forget / fail to". Without a determiner ("email API keys to me") the verb must
    // open a sentence or follow "please", so "use the manager to share credentials" stays a description.
    preceded: `(?:(?:(?<neg>(?<!\\bwhy )\\bnever|(?<!\\bwhy )\\bnot|(?<!\\bwhy do)n't|\\bno)\\b(?! (?:hesitate|forget|fail)\\b)`
      + `(?: ever)?(?: (?:ask|request|require|want|need|expect)(?: (?:you|anyone|users?|customers?|staff|employees))? to)? )?`
      + `\\b${CREDENTIAL_VERB}\\b (?:me |us |them )?(?:all |any |a copy of )?(?:of )?(?:your|the|their|our|my|these|those|all|any) `
      + `|(?:[.!?:;\\n] ?|\\bplease )${CREDENTIAL_VERB}\\b (?:me |us |them )?)(?:[a-z0-9-]{1,20} ){0,3}`,
    near: `\\b${CREDENTIAL_VERB}\\b`,
  }),
]);
