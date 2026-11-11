# Event Check-in & Raffle

A standalone browser app for assigning one unique QR code to each registered
member, checking members in, and keeping a separate raffle list of attendees.
It is independent of the wedding website.

## Run locally

1. Install Node.js 20.19+.
2. In this folder, run `npm install`.
3. Run `npm run dev` and open the local URL printed by Vite.

The starter roster contains fictional demo names. Add names in the app, view an
individual QR code, or print QR cards for the whole roster. On event day, start
the camera and scan each member's code. A second scan does not create another
raffle entry. If camera scanning is unavailable, paste the QR text into the
manual check-in field.

Without a Google Sheets connection, QR codes contain a scanner-only token and
must be scanned from inside the app. After connecting Google Sheets, newly
generated codes open a Google Apps Script check-in link, so a phone's regular
camera can record attendance directly.

## Put the scanner app online

To use the app's built-in camera scanner, the staff phone needs to open the app
over HTTPS. This repository includes a GitHub Actions workflow that builds and
deploys the app to GitHub Pages whenever a commit is pushed to `main`.

In the repository, open **Settings → Pages**, set the source to **GitHub
Actions**, and push to `main`. Once the workflow completes, open the Pages URL
shown in the repository settings. If using the printed QR cards with the
regular camera, connect Sheets first; guest QR links go directly to Google's
check-in page, not to the app URL.

## Use a separate scanner device

Use **Export QR roster for scanner device** on the device where you prepared and
printed the codes. Transfer the JSON file to the scanner device, open the app
there, and use **Import QR roster** before check-in starts. Import replaces that
device's roster and clears its local attendance data. Download the raffle
masterlist as CSV when check-in is complete.

Camera access requires `localhost` or a secure HTTPS deployment. Guest data,
QR tokens, and attendance are stored in that browser's local storage; there is
no login required for guests. Use one scanning device for the event. A
different browser/device has a separate list unless you connect it to Google
Sheets.

## Send check-ins to Google Sheets

The scanner phone needs internet for live Sheets sync. Guests only need to
bring their QR code; they do not need an account or app.

If **Extensions → Apps Script** is unavailable, create a standalone Apps Script
project instead:

1. Make sure the file is a native Google Sheet, not an `.xlsx` file. In Sheets,
   choose **File → Save as Google Sheets** and open the converted copy. Use that
   converted copy's ID from its URL.
2. Visit [script.google.com/home](https://script.google.com/home), select **New
   project**, and replace the editor contents with
   [`google-apps-script/Code.gs`](./google-apps-script/Code.gs).
3. In the project, open **Project Settings → Script Properties**, add property
   `CHECKIN_SPREADSHEET_ID` with the ID from the Google Sheet URL, and save.
4. Run `setupEventCheckin` once and approve the requested spreadsheet access.
   In the Apps Script execution log, copy the printed setup key.
5. Choose **Deploy → New deployment → Web app**, set **Execute as** to yourself,
   and access to **Anyone**. Deploy, approve access, and copy the `/exec` URL.
6. In the app, open **Google Sheets**, paste the web app URL and setup key, then
   choose **Connect & load roster**. Existing Members rows are loaded to this
   device; the local roster is uploaded only when the Members tab is empty.
7. Only after connecting, choose **Print QR cards** and distribute the new
   cards. Connected QR cards open the Apps Script endpoint directly, which
   records attendance without opening the scanner site's localhost URL.

The script creates `Members` and `Attendance` tabs. The app syncs its registered
roster, then appends each first check-in to `Attendance`. Re-scans do not create
another entry. If the connection drops, the scan stays in the app's local list
as **Pending**; reconnect and choose **Retry pending check-ins**.
Use **Refresh from Sheets** to load attendance recorded by guest QR scans or
check-ins from another device.

QR cards printed before connecting Google Sheets are old codes and cannot be
updated remotely. Discard and reprint them after connecting. Anyone with a
member's QR can use its link to check them in, so distribute the codes only to
the intended members.

The deployed Apps Script is a small Google-hosted endpoint. Its setup key is
stored in the scanner browser and is needed for roster sync and check-ins. Keep
the key private, use the app only with the intended event roster, and redeploy
the web app if you change the Apps Script code. Google Sheets requires an
internet connection; the local raffle list continues working if it is
temporarily unavailable.

## Build

Run `npm run build` to create the production site in `dist/`.
