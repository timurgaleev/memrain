/**
 * Meeting credentials in connector text: join links, ids, passcodes, PINs and
 * dial strings go, in English, German and Russian invitations from Teams,
 * Zoom, Webex and Google Meet; the prose around them stays. Every id,
 * passcode and number below is made up, and no fixture holds twelve digits in
 * a row (the PII audit reads that as an AWS account id).
 */
import { describe, expect, it } from "bun:test";
import { LINK_REMOVED, REMOVED, redactMeetingCredentials } from "../src/core/connectors/meeting-redact.ts";

interface Case { name: string; input: string; gone: string[]; kept: string[] }

const CASES: Case[] = [
  {
    name: "Teams, English",
    input: [
      "Microsoft Teams Need help?",
      "Join the meeting now",
      "Meeting ID: 311 222 333 444 55",
      "Passcode: Qw7er9Ty",
      "Dial in by phone",
      "+49 69 1234 5678,,987654321# Germany, Frankfurt",
      "Phone conference ID: 987 654 321#",
      "For organizers: Meeting options | Reset dial-in PIN",
    ].join("\n"),
    gone: ["311 222 333 444 55", "Qw7er9Ty", "987654321", "987 654 321"],
    kept: ["Reset dial-in PIN", "+49 69 1234 5678", "Join the meeting now", "Meeting ID: ", "Passcode: "],
  },
  {
    name: "Teams, German",
    input: [
      "Jetzt an der Besprechung teilnehmen",
      "Besprechungs-ID: 311 222 333 444 55",
      "Passcode: aB3cD4eF",
      "Telefonkonferenz-ID: 987 654 321#",
      "Für Organisatoren: Besprechungsoptionen | Einwahl-PIN zurücksetzen",
    ].join("\n"),
    gone: ["311 222 333 444 55", "aB3cD4eF", "987 654 321"],
    kept: ["Einwahl-PIN zurücksetzen", "Jetzt an der Besprechung teilnehmen"],
  },
  {
    name: "Teams, Russian",
    input: [
      "Собрание Microsoft Teams",
      "Идентификатор собрания: 311 222 333 444 55",
      "Секретный код: Zx8cV7bN",
      "Идентификатор конференции: 987 654 321#",
      "Идентификатор телефонной конференции: 987 654 320#",
      "ИД конференции: 987 654 322#",
    ].join("\n"),
    gone: ["311 222 333 444 55", "Zx8cV7bN", "987 654 321", "987 654 320", "987 654 322"],
    kept: ["Собрание Microsoft Teams"],
  },
  {
    name: "label and value in separate HTML cells",
    input: "Meeting ID:\n311 222 333 444 55\n\nPasscode:\nQw7er9Ty\nBesprechungs-ID\n311 222 333 444 555 6\nPasscode\n4829 1300",
    gone: ["311 222 333 444 55", "Qw7er9Ty", "444 555 6", "4829", "1300"],
    kept: [],
  },
  {
    name: "Teams links",
    input: "Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d and "
      + "https://teams.microsoft.com/meet/311222333444555?p=Qw7er9Ty\n"
      + "Chat: https://teams.microsoft.com/l/chat/19:abc/0 Entity: https://teams.microsoft.com/l/entity/x/y",
    gone: ["meetup-join", "311222333444555", "Qw7er9Ty"],
    kept: ["/l/chat/19:abc/0", "/l/entity/x/y"],
  },
  {
    name: "Teams, the plain-text invitation with its footer links",
    input: [
      "Microsoft Teams meeting",
      "Click here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmE0ZDk4@thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d>",
      "Meeting ID: 312 456 789 01",
      "Passcode: Ab3Cd4",
      "Join with a video conferencing device",
      "teams@vc.example.com",
      "Video Conference ID: 123 456 780 1",
      "Alternate VTC instructions<https://dialin.teams.microsoft.com/8551f4c1-bea3-441a-8738-69aa517a91c5/vtc?id=1234567801>",
      "Or call in (audio only)",
      "+1 323-555-0100,,123456789#<tel:+13235550100,,123456789#>   United States, Los Angeles",
      "Phone Conference ID: 123 456 789#",
      "Find a local number<https://dialin.teams.microsoft.com/8551f4c1-bea3-441a-8738-69aa517a91c5?id=123456789> | Reset PIN<https://dialin.teams.microsoft.com/usp/pstnconferencing>",
      "Learn More<https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=1b2c3d4e-0000-4000-8000-00000000000a&tenantId=5f6a7b8c-0000-4000-8000-00000000000b&threadId=19_meeting_ZmE0ZDk4@thread.v2&messageId=0&language=en-US>",
    ].join("\n"),
    gone: ["meetup-join", "ZmE0ZDk4", "312 456 789 01", "Ab3Cd4", "123 456 780 1", "1234567801", "123456789", "123 456 789", "organizerId", "tenantId", "threadId"],
    kept: [
      "Meeting options<", "Reset PIN<https://dialin.teams.microsoft.com/usp/pstnconferencing>", "Learn More<https://aka.ms/JoinTeamsMeeting>",
      "Find a local number<https://dialin.teams.microsoft.com/8551f4c1-bea3-441a-8738-69aa517a91c5?id=", "teams@vc.example.com",
      "+1 323-555-0100,,", "United States, Los Angeles",
    ],
  },
  {
    name: "Teams join links behind the web client",
    input: "Join: https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_abc@thread.v2/0?context=%7b%7d&anon=true now\n"
      + "Or: https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_def%40thread.v2%2F0 here",
    gone: ["meetup-join", "meeting_abc", "meeting_def"],
    kept: ["Join: ", " now\nOr: ", " here"],
  },
  {
    name: "a Meeting options, Google Meet or Webex link a mail gateway wrapped",
    input: [
      "Options: https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2FmeetingOptions%2F%3ForganizerId%3Daaa%26tenantId%3Dbbb%26threadId%3D19_meeting_abc%2540thread.v2&data=05 end",
      "Meet: https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij&data=05",
      "Webex: https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Facme.webex.com%2Facme%2Fj.php%3FMTID%3Dm0123456789abcdef0123456789abcdef&data=05",
    ].join("\n"),
    gone: ["threadId", "meeting_abc", "abc-defg-hij", "m0123456789abcdef"],
    kept: ["Options: ", " end", "Meet: ", "Webex: "],
  },
  {
    name: "Zoom, SIP and Skype for Business",
    input: [
      "Join by SIP",
      "• 81234567890@zoomcrc.com",
      "• 81234567891.482913@zoomcrc.com",
      "• 81234567892..482914@zoomcrc.com",
      "Join by Skype for Business",
      "https://us02web.zoom.us/skype/81234567893",
    ].join("\n"),
    gone: ["81234567890", "81234567891", "81234567892", "81234567893", "482913", "482914"],
    kept: ["Join by SIP", "@zoomcrc.com", "Join by Skype for Business"],
  },
  {
    name: "Webex, video system address and a tap-to-join string with the phone password",
    input: [
      "Tap to join from a mobile device (attendees only)",
      "+1-415-555-0001,,25123456789#22212345# US Toll",
      "Join by video system",
      "Dial 25123456788@acme.webex.com",
      "You can also dial 192.0.2.10 and enter your meeting number.",
    ].join("\n"),
    gone: ["25123456789", "22212345", "25123456788"],
    kept: ["+1-415-555-0001,,", " US Toll", "@acme.webex.com", "192.0.2.10", "enter your meeting number."],
  },
  {
    name: "a link a mail gateway wrapped",
    input: "Join: https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting_abc&data=05 now",
    gone: ["meetup-join", "meeting_abc"],
    kept: ["Join: ", " now"],
  },
  {
    name: "Zoom, English",
    input: [
      "Join Zoom Meeting",
      "https://us02web.zoom.us/j/81234567890?pwd=Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56.1",
      "Meeting ID: 812 3456 7890",
      "Passcode: 482913",
      "One tap mobile",
      "+4969710499,,81234567890#,,,,*48291300# Germany",
      "Find your local number: https://us02web.zoom.us/u/kdAbCdEfG",
    ].join("\n"),
    gone: ["81234567890", "Ab12Cd34", "812 3456 7890", "482913", "48291300"],
    kept: ["+4969710499,,", "https://us02web.zoom.us/u/kdAbCdEfG", "Join Zoom Meeting", "Germany"],
  },
  {
    name: "Zoom, German and Russian",
    input: "Zoom-Meeting beitreten\nMeeting-ID: 812 3456 7890\nKenncode: 482913\n"
      + "Подключиться к конференции Zoom\nИдентификатор конференции: 812 3456 7891\nКод доступа: 482914",
    gone: ["812 3456 7890", "482913", "812 3456 7891", "482914"],
    kept: ["Zoom-Meeting beitreten", "Подключиться к конференции Zoom"],
  },
  {
    name: "Webex",
    input: [
      "Meeting number (access code): 2730 123 4567",
      "Meeting password: XhB3Pnmp2v4 (94235766 from phones and video systems)",
      "Join: https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef0123456789abcdef",
      "Meeting-Kennnummer (Zugriffscode): 2730 123 4568",
      "Meeting-Passwort: XhB3Pnmp2v5",
    ].join("\n"),
    gone: ["2730 123 4567", "XhB3Pnmp2v4", "94235766", "MTID=m0123", "2730 123 4568", "XhB3Pnmp2v5"],
    kept: ["from phones and video systems)", "Join: "],
  },
  {
    name: "Google Meet",
    input: [
      "Join with Google Meet",
      "meet.google.com/abc-defg-hij",
      "Join by phone",
      "(US) +1 234-567-8901 PIN: 123 456 789#",
      "More phone numbers: https://tel.meet/abc-defg-hij?pin=1234567890123",
      "Mit Google Meet teilnehmen: https://meet.google.com/abc-defg-hij?hs=224",
      "(DE) +49 30 1234 5678 PIN-Code: 123 456 788#",
      "(RU) +7 495 123-45-67 PIN-код: 123 456 787#",
    ].join("\n"),
    gone: ["abc-defg-hij", "123 456 789", "1234567890123", "123 456 788", "123 456 787"],
    kept: ["(US) +1 234-567-8901", "Join by phone", "Mit Google Meet teilnehmen", "(DE) +49 30 1234 5678"],
  },
  {
    name: "an account password and its login link",
    input: "Ihre Zugangsdaten\nBenutzername: max\nPasswort: abcD1efg\nLogin: https://portal.example/login?user=max&pwd=abcD1efg",
    gone: ["abcD1efg"],
    kept: ["Benutzername: max", "Ihre Zugangsdaten", "https://portal.example/login?user=max&pwd="],
  },
  {
    name: "a card PIN",
    input: "Ihre neue Karte\nPIN: 4821 (Kreditkarte)\nПароль: Zx8cV7bQ",
    gone: ["4821", "Zx8cV7bQ"],
    kept: ["(Kreditkarte)", "Ihre neue Karte"],
  },
  {
    // A label with nothing after it does not take the next line: a date under
    // "Access code", a sign-off under "Password:" or "Passcode:".
    name: "a label whose next line is not its value",
    input: [
      "Access code",
      "2026-11-17 is when the new codes go out.",
      "Meeting ID:",
      "17.11.2026",
      "Conference ID: 2026-11-17 10:00",
      "Password:",
      "",
      "Thanks,",
      "Passcode:",
      "Regards,",
      "Bob",
    ].join("\n"),
    gone: [],
    kept: ["2026-11-17 is when", "17.11.2026", "2026-11-17 10:00", "Thanks,", "Regards,"],
  },
  {
    // A date guard keeps only a whole, real date; a sign-off is a sign-off word.
    name: "an id or a password that only looks like a date or a sign-off",
    input: [
      "Meeting ID: 2026-11-17-123456",
      "Meeting ID: 17.11.2026 812 3456 7890",
      "Meeting ID: 1234-56-78 9012",
      "Password:",
      "Tulpe,",
      "Meeting password:",
      "Regards, (123456 from phones)",
    ].join("\n"),
    gone: ["2026-11-17-123456", "812 3456 7890", "1234-56-78", "Tulpe,", "123456"],
    kept: ["Meeting ID: ", "Password:"],
  },
  {
    name: "a value on the line after its label",
    input: "Password:\n\nhunter22\nAccess code\n123 456 789",
    gone: ["hunter22", "123 456 789"],
    kept: ["Password:", "Access code"],
  },
  {
    name: "prose that names the labels",
    input: [
      "Passwort zurücksetzen: klicken Sie hier, um es zu ändern.",
      "Please reset your password before Friday.",
      "Password:",
      "Click the link below to choose a new one.",
      "Passcode:",
      "Please enter it when asked.",
      "The meeting ID will follow later.",
      "Passcode protected meeting",
      "Spin: 12345 and a pinned note; Benutzerkennung 12345678 bleibt.",
      "Invoice 2026-11-17, order 1234567890, call +49 30 1234 5678 before 10:00.",
      "Ticket ,,12 is fine. Total 1,234,567 EUR and 12,345,678.90 USD.",
      "Kunden-Kennung: 12345678 stays.",
      "Password: see the vault entry",
    ].join("\n"),
    gone: [],
    kept: [
      "Passwort zurücksetzen: klicken Sie hier", "Click the link below", "Please enter it when asked.",
      "The meeting ID will follow later.", "Passcode protected meeting", "Spin: 12345", "Benutzerkennung 12345678",
      "order 1234567890", "+49 30 1234 5678", "1,234,567 EUR", "12,345,678.90", "Kunden-Kennung: 12345678",
      "Password: see the vault entry",
    ],
  },
];

describe("redactMeetingCredentials", () => {
  for (const c of CASES) {
    it(`removes the credentials and keeps the prose: ${c.name}`, () => {
      const once = redactMeetingCredentials(c.input);
      for (const g of c.gone) expect(once.text).not.toContain(g);
      for (const k of c.kept) expect(once.text).toContain(k);
      if (c.gone.length > 0) expect(once.count).toBeGreaterThan(0);
      else expect(once).toEqual({ text: c.input, count: 0 });
    });
    it(`is idempotent: ${c.name}`, () => {
      const once = redactMeetingCredentials(c.input);
      const twice = redactMeetingCredentials(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.count).toBe(0);
    });
  }

  it("keeps the label and replaces only the value, with a marker that says nothing about it", () => {
    const r = redactMeetingCredentials("Meeting ID: 812 3456 7890\nPasscode: 482913\nhttps://us02web.zoom.us/j/81234567890?pwd=x1");
    expect(r.text).toBe(`Meeting ID: ${REMOVED}\nPasscode: ${REMOVED}\n${LINK_REMOVED}`);
    expect(r.count).toBe(3);
  });

  it("keeps the bridge number of a one-tap dial string", () => {
    expect(redactMeetingCredentials("+4969710499,,81234567890#,,,,*48291300#").text).toBe(`+4969710499,,${REMOVED}`);
  });

  it("leaves a scanner marker alone", () => {
    const text = "Password: [REDACTED:high-entropy-assignment:0123456789abcdef]\nlogin?pwd=[REDACTED:jwt:0123456789abcdef]";
    expect(redactMeetingCredentials(text)).toEqual({ text, count: 0 });
  });
});

describe("linear time", () => {
  /** Best-of-5 wall time, floored so sub-ms noise cannot fake a ratio. */
  const time = (s: string) => {
    Bun.gc(true);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      redactMeetingCredentials(s);
      best = Math.min(best, performance.now() - t);
    }
    return Math.max(best, 2);
  };
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const families: Record<string, string> = {
    "id label": "Meeting ID: 1 ",
    "passcode label": "Passcode:\n\n",
    "password label": "Password: aaa ",
    "dial commas": `${",".repeat(7)}1`,
    "pin label": "PIN: 1 ",
    "teams host": "https://teams.microsoft.com/meet/",
    "gateway prefix": "https://a",
    "webex host": "https://a.webex.com/",
    "teams chat link": "https://teams.microsoft.com/l/chat/",
    "teams dial-in host": "https://dialin.teams.microsoft.com/a?",
    "sip digits": "1234567890.a",
    "webex sip": "1234567890@a.",
    "word label": "Kennung",
    "pwd param": "?pwd=",
  };
  for (const [name, unit] of Object.entries(families)) {
    // Linear is 2x per doubling, quadratic 4x, taken over two doublings.
    it(`grows at most ~2.5x per doubling: ${name}`, () => {
      time(fill(unit, 20_000));
      const [a, , c] = [100_000, 200_000, 400_000].map(n => time(fill(unit, n)));
      expect(Math.sqrt(c! / a!)).toBeLessThan(2.5);
    });
  }
});
