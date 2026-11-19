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
 *
 * A `seq` entry matches when its parts appear in order inside one line or
 * sentence of the structural view, so a "verb … object … destination"
 * check costs one linear pass per part instead of a nested backtrack.
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
  | "memory_poisoning";

export type GateView = "prose" | "structural";

export interface GatePattern {
  name: string;
  family: GateFamily;
  view: GateView;
  /** One regex, or (structural view only) parts that must follow each other within a line or sentence. */
  re?: RegExp;
  seq?: readonly RegExp[];
}

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

export const WRITE_GATE_PATTERNS: readonly GatePattern[] = Object.freeze([
  // --- Directives addressed to an AI ---------------------------------------
  {
    name: "ignore_prior_instructions",
    family: "ai_directive",
    view: "prose",
    re: re(`${P}(?:ignore|disregard|forget|override|overrule|bypass|discard|abandon) ${gap(4)}`
      + `(?:previous|prior|above|earlier|preceding|initial|original|existing|current|system|safety|developer|all|any|your|these)${E} ${gap(3)}`
      + `(?:instructions?|prompts?|guardrails|programming|directives?|guidelines|rules|constraints|polic(?:y|ies))${E}`),
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
    re: re(`${P}you are now (?:an? |the |my )?(?:dan|jailbroken|unrestricted|unfiltered|uncensored|evil|no longer bound|(?:ai|assistant|model|bot|agent) (?:with|without|that))${E}`),
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
]);
