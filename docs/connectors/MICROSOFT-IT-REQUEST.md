# Request to your IT administrator: approve a read-only mail and calendar app

Copy the text below into an email or ticket to your IT administrator. Fill in
the placeholders first:

- `<app name>`: the name you gave the app ([MICROSOFT.md](./MICROSOFT.md) step 2).
- `<client-id>`: its **Application (client) ID**, from the app's **Overview** page.
- `<company-tenant-id-or-domain>`: your company's directory ID, or its email
  domain (for example `contoso.com`). If you do not know it, leave the
  placeholder: IT does.
- `<host>`: your Memrain server's address, as in your redirect URI.
- `<your name>` and `<your work address>`.
- `<aws-region>`: the AWS region your server and database run in (for
  example `eu-west-1`, Ireland).
- `<bedrock-regions>`: the regions your Bedrock calls may reach. With
  cross-region inference profiles that is more than one region; see
  [PRIVACY.md](../../PRIVACY.md#where-the-data-goes).
- `<assistants>`: every AI assistant or client you let read `work-mail` and
  `work-calendar` ([MICROSOFT.md](./MICROSOFT.md) step 9). Name each one;
  they receive search results, so they receive your work mail.
- Keep the Cloudflare line only if your server is reached through
  Cloudflare Tunnel (the default ingress); delete it otherwise.

Do not send the request with a placeholder left in it, and do not shorten
"Where the data goes": IT approves exactly what you write there.

[MICROSOFT.md, "For your IT administrator"](./MICROSOFT.md#for-your-it-administrator)
has the background, should IT ask for more. An English and a German version
follow.

---

## English

**Subject:** Request for admin consent: read-only access to my own Outlook mail and calendar

Hello,

I use a personal knowledge tool, Memrain, that keeps my own mail and calendar
searchable for me. I would like to connect my work account to it, and our
Microsoft 365 settings need an administrator to approve the app first. Could
you please review and, if acceptable, approve it?

- **App name:** `<app name>`
- **Application (client) ID:** `<client-id>`
- **Registered in:** my own Microsoft directory (not ours), so its publisher
  is not verified.
- **Permissions:** six delegated Microsoft Graph permissions, all read-only:
  `openid`, `email`, `offline_access`, `User.Read`, `Mail.Read`,
  `Calendars.Read`. No application permissions: the app acts only for a
  signed-in user and reads only that user's own mailbox and calendar.
- **What it reads:** my Inbox and Sent Items, and my calendar events. It never
  sends, changes or deletes anything.
- **Where the data goes:**
  - It is stored on my own Memrain server, in my own AWS account (region
    `<aws-region>`), and the server calls Microsoft Graph directly. Access
    tokens are stored encrypted.
  - To make it searchable, the text is indexed with Amazon Bedrock under the
    same AWS account (`<bedrock-regions>`). If I ask the server for a written
    answer, a Claude model on Amazon Bedrock reads the matching mail for it.
    Amazon does not use either to train models.
  - The AI assistants I connect to the server read search results, which
    can include this mail and these events: `<assistants>`.
  - Requests to my server pass through Cloudflare (Cloudflare Tunnel).

**To approve it**, please open this link signed in as an administrator
(Privileged Role Administrator, Cloud Application Administrator, Application
Administrator or AI Administrator), review the permissions and choose
**Accept**. The link approves the app for everyone in our organization:
please restrict it to me afterwards, as described below.

```
https://login.microsoftonline.com/<company-tenant-id-or-domain>/v2.0/adminconsent?client_id=<client-id>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<host>/admin/connectors/callback/microsoft
```

Afterwards a page on my server says "Admin consent recorded at Microsoft".
Please just close it.

**Please restrict it to me.** Once approved for the organization, any
colleague could sign in to the app without being asked, and their mail would
then be read by my server, which only I control. To prevent that, either:

- after approving, set **Assignment required?** to **Yes** on the app under
  **Enterprise apps > Properties**, and under **Users and groups** assign only
  me; or
- instead of the link, grant consent for my user only with Microsoft Graph
  PowerShell (`New-MgOauth2PermissionGrant` with `ConsentType` `Principal`).

Please note:

- The **Grant admin consent** buttons under App registrations and Enterprise
  apps will not work for this app, because it is registered in another
  directory. The link above is the way.
- If a request from me already reached your **Admin consent requests** list,
  please still approve with the link: it covers mail and calendar at once.
- The server renews its access from its own address, not from a company
  device. If a Conditional Access policy requires a compliant device or a
  company location for all cloud apps, the app would need an exclusion. Could
  you tell me if that applies?
- You can withdraw your approval at any time under Enterprise apps.

Thank you,
`<your name>` (`<your work address>`)

---

## Deutsch

**Betreff:** Bitte um Administratorzustimmung: Lesezugriff auf mein eigenes Outlook-Postfach und meinen Kalender

Hallo,

ich nutze ein persönliches Wissenswerkzeug, Memrain, das meine eigenen
E-Mails und Termine für mich durchsuchbar hält. Ich möchte mein
Arbeitskonto damit verbinden, und laut unseren Microsoft-365-Einstellungen
muss ein Administrator die App zuerst freigeben. Könnten Sie sie bitte
prüfen und, wenn es passt, freigeben?

- **Name der App:** `<app name>`
- **Anwendungs-ID (Client-ID):** `<client-id>`
- **Registriert in:** meinem eigenen Microsoft-Verzeichnis (nicht unserem),
  daher ist der Herausgeber nicht verifiziert.
- **Berechtigungen:** sechs delegierte Microsoft-Graph-Berechtigungen, alle
  nur lesend: `openid`, `email`, `offline_access`, `User.Read`, `Mail.Read`,
  `Calendars.Read`. Keine Anwendungsberechtigungen: Die App handelt nur für
  einen angemeldeten Benutzer und liest nur dessen eigenes Postfach und
  dessen eigenen Kalender.
- **Was gelesen wird:** mein Posteingang und meine gesendeten Elemente sowie
  meine Termine. Die App sendet, ändert oder löscht nie etwas.
- **Wohin die Daten gehen:**
  - Gespeichert werden sie auf meinem eigenen Memrain-Server in meinem
    eigenen AWS-Konto (Region `<aws-region>`); der Server ruft Microsoft
    Graph direkt auf. Zugriffstoken werden verschlüsselt gespeichert.
  - Damit sie durchsuchbar sind, wird der Text mit Amazon Bedrock im selben
    AWS-Konto indiziert (`<bedrock-regions>`). Wenn ich den Server um eine
    ausformulierte Antwort bitte, liest ein Claude-Modell auf Amazon Bedrock
    die passenden E-Mails dafür. Amazon verwendet beides nicht zum
    Trainieren von Modellen.
  - Die KI-Assistenten, die ich mit dem Server verbinde, lesen
    Suchergebnisse, die diese E-Mails und Termine enthalten können:
    `<assistants>`.
  - Anfragen an meinen Server laufen über Cloudflare (Cloudflare Tunnel).

**Zur Freigabe** öffnen Sie bitte diesen Link, angemeldet als Administrator
(Administrator für privilegierte Rollen, Cloudanwendungsadministrator,
Anwendungsadministrator oder KI-Administrator), prüfen die Berechtigungen und
wählen **Akzeptieren**. Der Link gibt die App für alle in unserer
Organisation frei: Bitte beschränken Sie sie danach auf mich, wie unten
beschrieben.

```
https://login.microsoftonline.com/<company-tenant-id-or-domain>/v2.0/adminconsent?client_id=<client-id>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<host>/admin/connectors/callback/microsoft
```

Danach zeigt eine Seite auf meinem Server „Admin consent recorded at
Microsoft“. Bitte schließen Sie sie einfach.

**Bitte beschränken Sie die App auf mich.** Nach der Freigabe für die
Organisation könnte sich jede Kollegin und jeder Kollege ohne Rückfrage bei
der App anmelden, und deren E-Mails würden dann von meinem Server gelesen,
den nur ich kontrolliere. Um das zu verhindern, entweder:

- nach der Freigabe unter **Unternehmensanwendungen > Eigenschaften** bei der
  App **Zuweisung erforderlich?** auf **Ja** setzen und unter **Benutzer und
  Gruppen** nur mich zuweisen, oder
- statt des Links die Zustimmung nur für meinen Benutzer mit Microsoft Graph
  PowerShell erteilen (`New-MgOauth2PermissionGrant` mit `ConsentType`
  `Principal`).

Bitte beachten Sie:

- Die Schaltflächen **Administratorzustimmung erteilen** unter
  App-Registrierungen und Unternehmensanwendungen funktionieren für diese App
  nicht, weil sie in einem anderen Verzeichnis registriert ist. Der Link oben
  ist der Weg.
- Falls bereits eine Anfrage von mir in Ihrer Liste der
  **Administratoreinwilligungsanforderungen** liegt, geben Sie die App bitte
  trotzdem über den Link frei: Er deckt E-Mail und Kalender auf einmal ab.
- Der Server erneuert seinen Zugriff von seiner eigenen Adresse aus, nicht
  von einem Firmengerät. Falls eine Richtlinie für bedingten Zugriff für alle
  Cloud-Apps ein konformes Gerät oder einen Firmenstandort verlangt, bräuchte
  die App eine Ausnahme. Könnten Sie mir sagen, ob das zutrifft?
- Sie können Ihre Freigabe jederzeit unter Unternehmensanwendungen
  widerrufen.

Vielen Dank
`<your name>` (`<your work address>`)
