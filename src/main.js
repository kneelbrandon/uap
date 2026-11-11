import QRCode from "qrcode";
import "./style.css";

const STORAGE_KEY = "event-check-in.v1";
const SHEET_CONFIG_KEY = "event-check-in.sheet.v1";
const QR_PREFIX = "event-check-in:";
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ROSTER_BATCH_SIZE = 10;
const starterNames = [
  "Jordan Lee",
  "Taylor Morgan",
  "Casey Rivera",
  "Avery Brooks",
  "Riley Santos",
  "Jamie Chen",
  "Quinn Parker",
  "Drew Williams",
];

const elements = {
  notice: document.querySelector("#notice"),
  memberCount: document.querySelector("#member-count"),
  checkedInCount: document.querySelector("#checked-in-count"),
  raffleCount: document.querySelector("#raffle-count"),
  memberList: document.querySelector("#member-list"),
  emptyRoster: document.querySelector("#empty-roster"),
  rosterStatus: document.querySelector("#roster-status"),
  raffleList: document.querySelector("#raffle-list"),
  emptyRaffle: document.querySelector("#empty-raffle"),
  addMemberForm: document.querySelector("#add-member-form"),
  memberName: document.querySelector("#member-name"),
  printCodes: document.querySelector("#print-codes"),
  exportRoster: document.querySelector("#export-roster"),
  importRoster: document.querySelector("#import-roster"),
  exportRaffle: document.querySelector("#export-raffle"),
  refreshAttendance: document.querySelector("#refresh-attendance"),
  video: document.querySelector("#scanner-video"),
  scannerPlaceholder: document.querySelector("#scanner-placeholder"),
  scannerStatus: document.querySelector("#scanner-status"),
  startScanner: document.querySelector("#start-scanner"),
  stopScanner: document.querySelector("#stop-scanner"),
  manualCheckInForm: document.querySelector("#manual-checkin-form"),
  manualQr: document.querySelector("#manual-qr"),
  sheetConfigForm: document.querySelector("#sheet-config-form"),
  sheetEndpoint: document.querySelector("#sheet-endpoint"),
  sheetKey: document.querySelector("#sheet-key"),
  saveSheetConfig: document.querySelector("#save-sheet-config"),
  syncPending: document.querySelector("#sync-pending"),
  sheetStatus: document.querySelector("#sheet-status"),
  sheetSetup: document.querySelector(".sheet-setup"),
  qrDialog: document.querySelector("#qr-dialog"),
  qrMemberName: document.querySelector("#qr-member-name"),
  qrHint: document.querySelector("#qr-hint"),
  qrImage: document.querySelector("#qr-image"),
  printSheet: document.querySelector("#print-sheet"),
};

let guests = loadGuests();
let scannerControls = null;
let scannerBusy = false;
let scannerStarting = false;
let attendanceRefreshing = false;
let sheetConfig = loadSheetConfig();

function createGuest(name) {
  return {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomUUID(),
    checkedInAt: null,
    sheetSyncedAt: null,
  };
}

function loadSheetConfig() {
  try {
    const saved = localStorage.getItem(SHEET_CONFIG_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return typeof parsed?.endpoint === "string" && typeof parsed?.key === "string"
      ? parsed
      : null;
  } catch (error) {
    console.error("Could not read the Google Sheets connection settings.", error);
    return null;
  }
}

function loadGuests() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) {
      const starterGuests = starterNames.map(createGuest);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(starterGuests));
      return starterGuests;
    }

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every(isGuest) || hasDuplicateIdsOrTokens(parsed)) {
      throw new Error("Saved roster has an invalid format.");
    }
    return parsed;
  } catch (error) {
    console.error("Could not read the saved event roster.", error);
    showNotice("The saved roster could not be read or initialized. Check browser storage, then reload.", "error");
    return [];
  }
}

function isGuest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= 100 &&
    typeof value.token === "string" &&
    UUID_PATTERN.test(value.token) &&
    (value.checkedInAt === null ||
      (typeof value.checkedInAt === "string" && Number.isFinite(Date.parse(value.checkedInAt)))) &&
    (value.sheetSyncedAt === undefined ||
      value.sheetSyncedAt === null ||
      (typeof value.sheetSyncedAt === "string" && Number.isFinite(Date.parse(value.sheetSyncedAt))))
  );
}

function hasDuplicateIdsOrTokens(list) {
  return (
    new Set(list.map((guest) => guest.id)).size !== list.length ||
    new Set(list.map((guest) => guest.token)).size !== list.length
  );
}

function qrContentFor(guest) {
  if (sheetConfig) {
    const url = new URL(sheetConfig.endpoint);
    url.searchParams.set("action", "guestCheckin");
    url.searchParams.set("token", guest.token);
    return url.toString();
  }

  return `${QR_PREFIX}${guest.token}`;
}

function tokenFromQr(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith(QR_PREFIX)) return value.slice(QR_PREFIX.length);

  try {
    const url = new URL(value);
    return url.searchParams.get("checkin") ?? url.searchParams.get("token") ?? "";
  } catch {
    return UUID_PATTERN.test(value) ? value : "";
  }
}

function saveGuests(nextGuests = guests) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextGuests));
    guests = nextGuests;
    render();
    return true;
  } catch (error) {
    console.error("Could not save the event roster.", error);
    showNotice("Changes could not be saved in this browser. Check available storage and try again.", "error");
    return false;
  }
}

function showNotice(message, type = "success") {
  elements.notice.textContent = message;
  elements.notice.className = `notice notice-${type}`;
  elements.notice.hidden = false;
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function render() {
  const checkedIn = guests.filter((guest) => guest.checkedInAt);
  elements.memberCount.textContent = String(guests.length);
  elements.checkedInCount.textContent = String(checkedIn.length);
  elements.raffleCount.textContent = String(checkedIn.length);
  elements.memberList.replaceChildren();
  elements.raffleList.replaceChildren();
  elements.emptyRoster.hidden = guests.length > 0;
  elements.emptyRaffle.hidden = checkedIn.length > 0;
  elements.sheetEndpoint.value = sheetConfig?.endpoint ?? "";
  elements.sheetKey.value = sheetConfig?.key ?? "";
  elements.syncPending.disabled = !sheetConfig || checkedIn.every((guest) => guest.sheetSyncedAt);
  elements.refreshAttendance.disabled = !sheetConfig || attendanceRefreshing;
  setSheetStatus(
    sheetConfig
      ? "Connected. The roster and check-ins will sync to Google Sheets."
      : "Not connected. Check-ins are currently saved only on this device."
  );

  guests.forEach((guest) => {
    const item = document.createElement("li");
    item.className = "member-row";

    const info = document.createElement("div");
    info.className = "member-info";
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = guest.name;
    const status = document.createElement("span");
    status.className = `member-status ${guest.checkedInAt ? "is-checked-in" : ""}`;
    status.textContent = guest.checkedInAt ? "Checked in" : "Not checked in";
    info.append(name, status);

    const actions = document.createElement("div");
    actions.className = "member-actions";
    const qrButton = document.createElement("button");
    qrButton.className = "small-button";
    qrButton.type = "button";
    qrButton.textContent = "View QR";
    qrButton.addEventListener("click", () => showQr(guest));

    const removeButton = document.createElement("button");
    removeButton.className = "small-button small-button-muted";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.setAttribute("aria-label", `Remove ${guest.name}`);
    removeButton.addEventListener("click", () => removeGuest(guest, removeButton));
    actions.append(qrButton, removeButton);

    item.append(info, actions);
    elements.memberList.append(item);
  });

  checkedIn.forEach((guest, index) => {
    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.textContent = String(index + 1);
    const name = document.createElement("td");
    name.className = "raffle-name";
    name.textContent = guest.name;
    const time = document.createElement("td");
    time.textContent = formatTime(guest.checkedInAt);
    const sheetStatus = document.createElement("td");
    sheetStatus.textContent = !sheetConfig
      ? "Local only"
      : guest.sheetSyncedAt
        ? "Synced"
        : "Pending";
    row.append(number, name, time, sheetStatus);
    elements.raffleList.append(row);
  });
}

function setSheetStatus(message, type = "") {
  elements.sheetStatus.textContent = message;
  elements.sheetStatus.className = `sheet-status${type ? ` is-${type}` : ""}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function removeGuest(guest, removeButton) {
  const prompt = guest.checkedInAt
    ? `${guest.name} is already checked in. Removing them will also remove their raffle entry. Continue?`
    : `Remove ${guest.name} from this roster?`;
  if (!window.confirm(prompt)) return;

  if (removeButton) {
    removeButton.disabled = true;
    removeButton.textContent = "Removing…";
  }
  elements.rosterStatus.textContent = sheetConfig
    ? `Removing ${guest.name} from the roster and Google Sheets…`
    : `Removing ${guest.name} from this device…`;
  elements.rosterStatus.className = "roster-status";

  try {
    if (sheetConfig) {
      await callSheet("remove", { id: guest.id });
    }

    if (!saveGuests(guests.filter((item) => item.id !== guest.id))) {
      elements.rosterStatus.textContent = `Could not remove ${guest.name}. Check this device’s browser storage and try again.`;
      elements.rosterStatus.className = "roster-status is-error";
      if (removeButton) {
        removeButton.disabled = false;
        removeButton.textContent = "Remove";
      }
      return;
    }

    elements.rosterStatus.textContent = `${guest.name} removed from the roster${sheetConfig ? " and Google Sheets" : ""}.`;
    showNotice(`${guest.name} was removed from the roster.`);
  } catch (error) {
    console.error("Could not remove the member from Google Sheets.", error);
    elements.rosterStatus.textContent = `Could not remove ${guest.name} from Google Sheets: ${
      error instanceof Error ? error.message : "The request failed."
    }`;
    elements.rosterStatus.className = "roster-status is-error";
    showNotice(`Could not remove ${guest.name}. See the roster message for details.`, "error");
    if (removeButton) {
      removeButton.disabled = false;
      removeButton.textContent = "Remove";
    }
  }
}

async function showQr(guest) {
  try {
    elements.qrMemberName.textContent = guest.name;
    elements.qrHint.textContent = sheetConfig
      ? "Scan with any phone camera to check in directly to Google Sheets."
      : "Connect Google Sheets before printing codes for phone-camera check-in.";
    elements.qrImage.src = await QRCode.toDataURL(qrContentFor(guest), {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "H",
    });
    elements.qrImage.alt = `Unique QR code for ${guest.name}`;
    elements.qrDialog.showModal();
  } catch (error) {
    console.error("Could not generate the member QR code.", error);
    showNotice(`Could not generate a QR code for ${guest.name}.`, "error");
  }
}

elements.addMemberForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice();
  const name = elements.memberName.value.trim();
  if (!name) return;
  if (guests.some((guest) => guest.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    showNotice("A member with that name is already on the roster.", "error");
    return;
  }

  const nextGuests = [...guests, createGuest(name)];
  if (saveGuests(nextGuests)) {
    elements.memberName.value = "";
    if (sheetConfig) {
      try {
        await syncRosterToSheet();
        showNotice(`${name} was added and synced to Google Sheets.`);
      } catch (error) {
        console.error("Member was added locally, but roster sync failed.", error);
        showNotice(
          `${name} was added on this device, but the Google Sheets roster could not be updated. Retry “Connect & sync roster”.`,
          "error"
        );
        setSheetStatus("Roster sync failed. Reconnect and sync the roster before checking this member in.", "error");
      }
    } else {
      showNotice(`${name} was added. Their unique QR code is ready.`);
    }
  }
});

elements.printCodes.addEventListener("click", async () => {
  clearNotice();
  if (guests.length === 0) {
    showNotice("Add at least one member before printing QR cards.", "error");
    return;
  }

  elements.printCodes.disabled = true;
  elements.printSheet.replaceChildren();
  try {
    for (const guest of guests) {
      const card = document.createElement("article");
      card.className = "print-card";
      const name = document.createElement("h2");
      name.textContent = guest.name;
      const image = document.createElement("img");
      image.alt = `Unique QR code for ${guest.name}`;
      image.src = await QRCode.toDataURL(qrContentFor(guest), {
        width: 260,
        margin: 2,
        errorCorrectionLevel: "H",
      });
      const label = document.createElement("p");
      label.textContent = "Present this code at event check-in";
      card.append(name, image, label);
      elements.printSheet.append(card);
    }

    window.print();
  } catch (error) {
    console.error("Could not prepare the QR cards for printing.", error);
    showNotice("Could not prepare the QR cards for printing. Please try again.", "error");
  } finally {
    elements.printCodes.disabled = false;
  }
});

function downloadFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

elements.exportRoster.addEventListener("click", () => {
  const roster = guests.map(({ id, name, token }) => ({ id, name, token }));
  downloadFile(
    "event-qr-roster.json",
    JSON.stringify(roster, null, 2),
    "application/json"
  );
  showNotice("QR roster exported. Import this file on the device used to scan.");
});

elements.importRoster.addEventListener("change", async (event) => {
  const [file] = event.currentTarget.files ?? [];
  event.currentTarget.value = "";
  if (!file) return;

  try {
    const imported = JSON.parse(await file.text());
    if (
      !Array.isArray(imported) ||
      !imported.every(
        (guest) =>
          guest &&
          typeof guest.id === "string" &&
          UUID_PATTERN.test(guest.id) &&
          typeof guest.name === "string" &&
          guest.name.trim().length > 0 &&
          guest.name.length <= 100 &&
          typeof guest.token === "string" &&
          UUID_PATTERN.test(guest.token)
      ) ||
      hasDuplicateIdsOrTokens(imported)
    ) {
      throw new Error("The file does not contain a valid QR roster.");
    }

    if (!window.confirm(`Replace this device’s roster with ${imported.length} members? Existing attendance data on this device will be cleared.`)) {
      return;
    }

    const nextGuests = imported.map((guest) => ({
      id: guest.id,
      name: guest.name,
      token: guest.token,
      checkedInAt: null,
    }));
    if (saveGuests(nextGuests)) {
      if (sheetConfig) {
        try {
          await syncRosterToSheet();
          showNotice(`Imported and synced ${nextGuests.length} members. This device is ready to scan.`);
        } catch (error) {
          console.error("Imported roster saved locally, but Google Sheets sync failed.", error);
          showNotice(
            "Roster imported locally, but Google Sheets could not be updated. Retry “Connect & sync roster” before scanning.",
            "error"
          );
          setSheetStatus("Roster sync failed. Reconnect and sync the roster before scanning.", "error");
        }
      } else {
        showNotice(`Imported ${nextGuests.length} members. This device is ready to scan their QR codes.`);
      }
    }
  } catch (error) {
    console.error("Could not import the QR roster.", error);
    showNotice(error instanceof Error ? error.message : "Could not import the QR roster.", "error");
  }
});

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Google Apps Script web app URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "script.google.com" ||
    !/^\/macros\/s\/[^/]+\/(?:exec|dev)\/?$/.test(url.pathname)
  ) {
    throw new Error("Use the deployed HTTPS Apps Script URL ending in /exec.");
  }
  return url.toString();
}

function callSheet(action, parameters = {}) {
  if (!sheetConfig) return Promise.reject(new Error("Google Sheets is not connected."));

  return new Promise((resolve, reject) => {
    const callbackName = `__eventSheet_${crypto.randomUUID().replaceAll("-", "")}`;
    const script = document.createElement("script");
    const url = new URL(sheetConfig.endpoint);
    url.searchParams.set("action", action);
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("key", sheetConfig.key);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    const cleanup = () => {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Google Sheets did not respond. Check the connection and retry."));
    }, 15000);

    window[callbackName] = (result) => {
      cleanup();
      if (!result || result.ok !== true) {
        reject(new Error(result?.error || "Google Sheets rejected the request."));
        return;
      }
      resolve(result);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("Could not reach the Google Sheets web app. Check its URL and deployment access."));
    };
    script.src = url.toString();
    document.head.append(script);
  });
}

async function syncRosterToSheet() {
  if (!sheetConfig) throw new Error("Connect Google Sheets before syncing the roster.");
  const roster = guests.map(({ id, name, token }) => ({ id, name, token }));
  if (roster.length === 0) {
    await callSheet("sync", { members: [], replace: true, finalize: true });
    return;
  }
  for (let index = 0; index < roster.length; index += ROSTER_BATCH_SIZE) {
    await callSheet("sync", {
      members: roster.slice(index, index + ROSTER_BATCH_SIZE),
      replace: index === 0,
      finalize: index + ROSTER_BATCH_SIZE >= roster.length,
    });
  }
}

async function syncGuestToSheet(guest) {
  const result = await callSheet("checkin", { token: guest.token });
  return result.checkedInAt || new Date().toISOString();
}

function validateSheetAttendance(result) {
  if (
    !Array.isArray(result.members) ||
    !Array.isArray(result.attendance) ||
    !result.members.every((member) =>
      isGuest({ ...member, checkedInAt: null, sheetSyncedAt: null })
    ) ||
    !result.attendance.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        UUID_PATTERN.test(entry.id) &&
        typeof entry.name === "string" &&
        entry.name.trim().length > 0 &&
        typeof entry.checkedInAt === "string" &&
        Number.isFinite(Date.parse(entry.checkedInAt))
    ) ||
    new Set(result.members.map((member) => member.id)).size !== result.members.length ||
    new Set(result.members.map((member) => member.token)).size !== result.members.length ||
    new Set(result.attendance.map((entry) => entry.id)).size !== result.attendance.length
  ) {
    throw new Error("Google Sheets returned an invalid roster or attendance list.");
  }
  return result;
}

function applySheetAttendance(result) {
  const localMembers = new Map(guests.map((guest) => [guest.id, guest]));
  const sheetAttendance = new Map(result.attendance.map((entry) => [entry.id, entry]));
  const merged = result.members.map((member) => {
    const local = localMembers.get(member.id);
    const attendance = sheetAttendance.get(member.id);
    return {
      ...member,
      checkedInAt:
        attendance?.checkedInAt ??
        (local?.sheetSyncedAt ? null : local?.checkedInAt ?? null),
      sheetSyncedAt: attendance?.checkedInAt ?? null,
    };
  });

  if (!saveGuests(merged)) {
    throw new Error("Could not save the refreshed attendance on this device.");
  }
}

async function refreshAttendanceFromSheet(quiet = false) {
  if (!sheetConfig || attendanceRefreshing) return;

  attendanceRefreshing = true;
  elements.refreshAttendance.disabled = true;
  elements.refreshAttendance.textContent = "Refreshing…";
  setSheetStatus("Loading the roster and attendance from Google Sheets…");
  try {
    const result = validateSheetAttendance(await callSheet("attendance"));
    applySheetAttendance(result);
    setSheetStatus(
      `Refreshed from Google Sheets. ${result.attendance.length} guest${
        result.attendance.length === 1 ? "" : "s"
      } checked in.`,
      "success"
    );
    if (!quiet) {
      showNotice(
        `${result.attendance.length} check-in${result.attendance.length === 1 ? "" : "s"} loaded from Google Sheets.`
      );
    }
  } catch (error) {
    console.error("Could not refresh attendance from Google Sheets.", error);
    const message = error instanceof Error ? error.message : "Could not load attendance.";
    setSheetStatus(message, "error");
    if (!quiet) showNotice(`Could not refresh attendance: ${message}`, "error");
  } finally {
    attendanceRefreshing = false;
    elements.refreshAttendance.textContent = "Refresh from Sheets";
    elements.refreshAttendance.disabled = !sheetConfig;
  }
}

elements.sheetConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.saveSheetConfig.disabled = true;
  setSheetStatus("Connecting and syncing the registered roster…");
  try {
    const endpoint = validateEndpoint(elements.sheetEndpoint.value.trim());
    const key = elements.sheetKey.value.trim();
    if (!key) throw new Error("Enter the setup key from Google Apps Script.");

    const nextConfig = { endpoint, key };
    localStorage.setItem(SHEET_CONFIG_KEY, JSON.stringify(nextConfig));
    sheetConfig = nextConfig;
    let result = validateSheetAttendance(await callSheet("attendance"));
    if (result.members.length === 0) {
      await syncRosterToSheet();
      result = validateSheetAttendance(await callSheet("attendance"));
    }
    applySheetAttendance(result);
    render();
    setSheetStatus(
      `Connected. ${guests.length} registered members and ${result.attendance.length} check-ins loaded from Google Sheets.`,
      "success"
    );
    elements.sheetSetup.open = false;
  } catch (error) {
    console.error("Could not connect or sync the Google Sheets roster.", error);
    setSheetStatus(
      error instanceof Error ? error.message : "Could not connect to Google Sheets.",
      "error"
    );
  } finally {
    elements.saveSheetConfig.disabled = false;
  }
});

elements.refreshAttendance.addEventListener("click", () => refreshAttendanceFromSheet());

elements.syncPending.addEventListener("click", async () => {
  if (!sheetConfig) return;
  elements.syncPending.disabled = true;
  const pending = guests.filter((guest) => guest.checkedInAt && !guest.sheetSyncedAt);
  let synced = 0;
  try {
    for (const guest of pending) {
      const checkedInAt = await syncGuestToSheet(guest);
      const nextGuests = guests.map((item) =>
        item.id === guest.id ? { ...item, sheetSyncedAt: checkedInAt } : item
      );
      if (!saveGuests(nextGuests)) throw new Error("Could not save the sync status on this device.");
      synced += 1;
    }
    setSheetStatus(
      pending.length
        ? `Synced ${synced} pending check-in${synced === 1 ? "" : "s"} to Google Sheets.`
        : "No pending check-ins. Google Sheets is up to date.",
      "success"
    );
  } catch (error) {
    console.error("Could not sync pending check-ins.", error);
    setSheetStatus(
      `${synced} of ${pending.length} pending check-ins synced. ${
        error instanceof Error ? error.message : "Try again."
      }`,
      "error"
    );
  } finally {
    elements.syncPending.disabled = false;
  }
});

elements.exportRaffle.addEventListener("click", () => {
  const checkedIn = guests.filter((guest) => guest.checkedInAt);
  if (checkedIn.length === 0) {
    showNotice("There are no raffle entries to export yet.", "error");
    return;
  }

  const rows = [
    ["Number", "Member", "Checked in at"],
    ...checkedIn.map((guest, index) => [
      index + 1,
      guest.name,
      new Date(guest.checkedInAt).toISOString(),
    ]),
  ];
  downloadFile(
    "event-raffle-masterlist.csv",
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n"),
    "text/csv;charset=utf-8"
  );
  showNotice(`${checkedIn.length} raffle entries downloaded.`);
});

async function checkIn(rawValue) {
  const token = tokenFromQr(rawValue);
  if (!token || !UUID_PATTERN.test(token)) {
    showNotice("That QR code is not an event check-in code.", "error");
    return false;
  }

  const guest = guests.find((item) => item.token === token);
  if (!guest) {
    showNotice("This QR code is not in the imported roster.", "error");
    return false;
  }
  if (guest.checkedInAt) {
    if (sheetConfig && !guest.sheetSyncedAt) {
      try {
        const checkedInAt = await syncGuestToSheet(guest);
        const nextGuests = guests.map((item) =>
          item.id === guest.id ? { ...item, sheetSyncedAt: checkedInAt } : item
        );
        if (!saveGuests(nextGuests)) return false;
        showNotice(`${guest.name} was already checked in and is now synced to Google Sheets.`);
        return true;
      } catch (error) {
        console.error("Could not sync this pending check-in.", error);
        showNotice(
          `${guest.name} is on this device, but Google Sheets could not be updated. Retry the pending check-ins when connected.`,
          "error"
        );
        return false;
      }
    }
    showNotice(`${guest.name} is already checked in and has one raffle entry.`, "error");
    return false;
  }

  const checkedInAt = new Date().toISOString();
  const nextGuests = guests.map((item) =>
    item.id === guest.id
      ? { ...item, checkedInAt, sheetSyncedAt: sheetConfig ? null : undefined }
      : item
  );
  if (!saveGuests(nextGuests)) return false;

  if (!sheetConfig) {
    showNotice(`${guest.name} checked in and added to the raffle list.`);
    return true;
  }

  try {
    const syncedAt = await syncGuestToSheet(guest);
    const syncedGuests = guests.map((item) =>
      item.id === guest.id ? { ...item, sheetSyncedAt: syncedAt } : item
    );
    if (!saveGuests(syncedGuests)) {
      showNotice(`${guest.name} was checked in, but this device could not save the Google Sheets sync status.`, "error");
      return false;
    }
    showNotice(`${guest.name} checked in and added to the raffle list and Google Sheet.`);
    return true;
  } catch (error) {
    console.error("Check-in was saved locally, but Google Sheets sync failed.", error);
    showNotice(
      `${guest.name} was added on this device, but Google Sheets could not be reached. Their entry is pending sync.`,
      "error"
    );
    setSheetStatus(error instanceof Error ? error.message : "Google Sheets sync failed.", "error");
    return true;
  }
}

elements.manualCheckInForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const scannedValue = elements.manualQr.value;
  checkIn(scannedValue).then((success) => {
    if (success) elements.manualQr.value = "";
  });
});

async function startScanner() {
  if (scannerControls || scannerStarting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    elements.scannerStatus.textContent = "Camera scanning requires localhost or a secure HTTPS connection.";
    return;
  }

  scannerStarting = true;
  elements.startScanner.disabled = true;
  elements.scannerStatus.textContent = "Requesting camera access…";

  try {
    const { BrowserQRCodeReader } = await import("@zxing/browser");
    const reader = new BrowserQRCodeReader();
    scannerControls = await reader.decodeFromVideoDevice(
      undefined,
      elements.video,
      (result, _error, controls) => {
        if (!result || scannerBusy) return;
        scannerBusy = true;
        controls.stop();
        stopScanner();
        elements.scannerStatus.textContent = "Camera paused after scan. Start it again for the next member.";
        checkIn(result.getText()).finally(() => {
          scannerBusy = false;
        });
      }
    );
    elements.scannerPlaceholder.hidden = true;
    elements.scannerStatus.textContent = "Camera is on. Point it at a member’s QR code.";
    elements.startScanner.disabled = true;
    elements.stopScanner.disabled = false;
  } catch (error) {
    console.error("Could not start the QR scanner.", error);
    elements.scannerStatus.textContent =
      "Could not start the camera. Allow camera access in your browser and try again.";
    scannerControls = null;
    elements.startScanner.disabled = false;
  } finally {
    scannerStarting = false;
  }
}

function stopScanner() {
  scannerControls?.stop();
  scannerControls = null;
  elements.video.srcObject?.getTracks().forEach((track) => track.stop());
  elements.video.srcObject = null;
  elements.scannerPlaceholder.hidden = false;
  elements.startScanner.disabled = false;
  elements.stopScanner.disabled = true;
}

elements.startScanner.addEventListener("click", startScanner);
elements.stopScanner.addEventListener("click", () => {
  stopScanner();
  elements.scannerStatus.textContent = "Camera is off.";
});
window.addEventListener("beforeunload", stopScanner);

render();
if (sheetConfig) refreshAttendanceFromSheet(true);

const checkinFromUrl = new URL(window.location.href).searchParams.get("checkin");
if (checkinFromUrl) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("checkin");
  window.history.replaceState({}, "", cleanUrl);
  checkIn(checkinFromUrl);
}
