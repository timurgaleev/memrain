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
- The data location says AWS, region eu-west-1 (Ireland), Memrain's standard
  setup: change it if your server runs elsewhere.

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
  `Calendars.Read`. No application permissions: the app can only read my own
  mailbox and calendar, as me, while my consent stands.
- **What it reads:** my Inbox and Sent Items, and my calendar events. It never
  sends, changes or deletes anything.
- **Where the data goes:** to my own Memrain server only (AWS, region
  eu-west-1, Ireland). The server calls Microsoft Graph directly; no other
  service is involved. Access tokens are stored encrypted.

**To approve it**, please open this link signed in as an administrator
(Privileged Role Administrator, Cloud Application Administrator, Application
Administrator or AI Administrator), review the permissions and choose
**Accept**:

```
https://login.microsoftonline.com/<company-tenant-id-or-domain>/v2.0/adminconsent?client_id=<client-id>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<host>/admin/connectors/callback/microsoft
```

Afterwards a page on my server says "Admin consent recorded at Microsoft".
Please just close it.

Please note:

- The **Grant admin consent** buttons under App registrations and Enterprise
  apps will not work for this app, because it is registered in another
  directory. The link above is the way.
- If you prefer to limit it to me, you can set **Assignment required?** to
  **Yes** on the app under Enterprise apps after approving, and assign only
  me; or grant consent for my user only with Microsoft Graph PowerShell
  (`New-MgOauth2PermissionGrant` with `ConsentType` `Principal`).
- The server renews its access from its own address, not from a company
  device. If a Conditional Access policy requires a compliant device or a
  company location for all cloud apps, the app would need an exclusion. Could
  you tell me if that applies?
- You can withdraw the app at any time under Enterprise apps.

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
  `Calendars.Read`. Keine Anwendungsberechtigungen: Die App kann nur mein
  eigenes Postfach und meinen eigenen Kalender lesen, in meinem Namen und
  nur, solange meine Zustimmung besteht.
- **Was gelesen wird:** mein Posteingang und meine gesendeten Elemente sowie
  meine Termine. Die App sendet, ändert oder löscht nie etwas.
- **Wohin die Daten gehen:** ausschließlich auf meinen eigenen
  Memrain-Server (AWS, Region eu-west-1, Irland). Der Server ruft Microsoft
  Graph direkt auf; kein anderer Dienst ist beteiligt. Zugriffstoken werden
  verschlüsselt gespeichert.

**Zur Freigabe** öffnen Sie bitte diesen Link, angemeldet als Administrator
(Administrator für privilegierte Rollen, Cloudanwendungsadministrator,
Anwendungsadministrator oder KI-Administrator), prüfen die Berechtigungen und
wählen **Akzeptieren**:

```
https://login.microsoftonline.com/<company-tenant-id-or-domain>/v2.0/adminconsent?client_id=<client-id>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<host>/admin/connectors/callback/microsoft
```

Danach zeigt eine Seite auf meinem Server „Admin consent recorded at
Microsoft“. Bitte schließen Sie sie einfach.

Bitte beachten Sie:

- Die Schaltflächen **Administratorzustimmung erteilen** unter
  App-Registrierungen und Unternehmensanwendungen funktionieren für diese App
  nicht, weil sie in einem anderen Verzeichnis registriert ist. Der Link oben
  ist der Weg.
- Wenn Sie den Zugriff auf mich beschränken möchten, können Sie nach der
  Freigabe unter Unternehmensanwendungen bei der App **Zuweisung
  erforderlich?** auf **Ja** setzen und nur mich zuweisen, oder die
  Zustimmung nur für meinen Benutzer mit Microsoft Graph PowerShell erteilen
  (`New-MgOauth2PermissionGrant` mit `ConsentType` `Principal`).
- Der Server erneuert seinen Zugriff von seiner eigenen Adresse aus, nicht
  von einem Firmengerät. Falls eine Richtlinie für bedingten Zugriff für alle
  Cloud-Apps ein konformes Gerät oder einen Firmenstandort verlangt, bräuchte
  die App eine Ausnahme. Könnten Sie mir sagen, ob das zutrifft?
- Sie können die App jederzeit unter Unternehmensanwendungen wieder
  entfernen.

Vielen Dank
`<your name>` (`<your work address>`)
