// A text/event-stream reader for a POSTed request: EventSource only does GET,
// so the Ask page reads the response body itself and feeds the decoded text
// here in whatever chunks the network delivers. Follows the WHATWG field
// rules the page needs (event, data, comments, CRLF/CR/LF line ends); id and
// retry are ignored because a chat turn is never resumed. No DOM.

export interface SseMessage { event: string; data: string }

export interface SseParser {
  push(chunk: string): void;
  /** The stream ended; an event without its closing blank line is dropped. */
  end(): void;
}

export function createSseParser(onMessage: (m: SseMessage) => void): SseParser {
  let buffer = "";
  let event = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || "message", data: data.join("\n") });
    event = "";
    data = [];
  };

  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };

  return {
    push(chunk) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A CR at the very end may be the first half of a CRLF; wait for more.
        if (c === "\r" && i === buffer.length - 1) break;
        line(buffer.slice(start, i));
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      // A held CR was a line end after all.
      if (buffer.endsWith("\r")) line(buffer.slice(0, -1));
      buffer = "";
      event = "";
      data = [];
    },
  };
}
