const MEMBERS_SHEET = "Members";
const ATTENDANCE_SHEET = "Attendance";
const ADMIN_KEY_PROPERTY = "CHECKIN_ADMIN_KEY";
const SPREADSHEET_ID_PROPERTY = "CHECKIN_SPREADSHEET_ID";
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MEMBER_HEADERS = ["Member ID", "Name", "QR Token"];
const ATTENDANCE_HEADERS = ["Member ID", "Name", "Checked In At"];

function setupEventCheckin() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty(SPREADSHEET_ID_PROPERTY);
  const spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error(
      "Set the CHECKIN_SPREADSHEET_ID script property to your Google Sheet ID, then run setup again."
    );
  }

  properties.setProperty(SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
  ensureSheet_(spreadsheet, MEMBERS_SHEET, MEMBER_HEADERS);
  ensureSheet_(spreadsheet, ATTENDANCE_SHEET, ATTENDANCE_HEADERS);

  let key = properties.getProperty(ADMIN_KEY_PROPERTY);
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    properties.setProperty(ADMIN_KEY_PROPERTY, key);
  }

  console.log("Event check-in setup key (copy it into the scanner app): " + key);
  return key;
}

function doGet(event) {
  const parameters = event?.parameter || {};
  if (parameters.action === "guestCheckin") {
    try {
      const result = checkIn_(String(parameters.token || ""));
      return guestCheckinPage_(result);
    } catch (error) {
      console.error("Guest check-in failed: " + error.message);
      return guestCheckinPage_({
        status: "error",
        error: error instanceof Error ? error.message : "The check-in failed.",
      });
    }
  }

  const callback = String(event?.parameter?.callback || "");
  if (!/^__eventSheet_[a-f0-9]{32}$/.test(callback)) {
    return jsonp_("__eventSheet_invalid", {
      ok: false,
      error: "Invalid request callback.",
    });
  }

  try {
    const key = PropertiesService.getScriptProperties().getProperty(ADMIN_KEY_PROPERTY);
    if (!key || !constantTimeEquals_(String(parameters.key || ""), key)) {
      throw new Error("The Apps Script setup key is incorrect.");
    }

    let result;
    if (parameters.action === "sync") {
      result = syncMembers_(
        parameters.members,
        parameters.replace === "true",
        parameters.finalize === "true"
      );
    } else if (parameters.action === "attendance") {
      result = getAttendance_();
    } else if (parameters.action === "checkin") {
      result = checkIn_(String(parameters.token || ""));
    } else if (parameters.action === "remove") {
      result = removeMember_(String(parameters.id || ""));
    } else {
      throw new Error("Unknown action.");
    }
    return jsonp_(callback, Object.assign({ ok: true }, result));
  } catch (error) {
    console.error("Event check-in request failed: " + error.message);
    return jsonp_(callback, {
      ok: false,
      error: error instanceof Error ? error.message : "The request failed.",
    });
  }
}

function syncMembers_(membersJson, replace, finalize) {
  const members = JSON.parse(String(membersJson || ""));
  if (
    !Array.isArray(members) ||
    members.length > 5000 ||
    !members.every(isMember_)
  ) {
    throw new Error("The roster is invalid. Sync it again from the scanner app.");
  }
  if (
    new Set(members.map(function (member) { return member.id; })).size !== members.length ||
    new Set(members.map(function (member) { return member.token; })).size !== members.length
  ) {
    throw new Error("The roster contains duplicate IDs or QR codes.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_(MEMBERS_SHEET);
    const lastRow = sheet.getLastRow();
    const rosterById = new Map();
    if (!replace && lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, MEMBER_HEADERS.length).getValues().forEach(function (row) {
        rosterById.set(String(row[0]), row);
      });
    }
    members.forEach(function (member) {
      rosterById.set(member.id, [member.id, member.name, member.token]);
    });

    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, MEMBER_HEADERS.length).clearContent();
    const rows = Array.from(rosterById.values());
    if (rows.length) sheet.getRange(2, 1, rows.length, MEMBER_HEADERS.length).setValues(rows);
    if (finalize) removeAttendanceOutsideRoster_(rosterById);
    SpreadsheetApp.flush();
    return { count: members.length };
  } finally {
    lock.releaseLock();
  }
}

function removeAttendanceOutsideRoster_(rosterById) {
  const attendanceSheet = getSheet_(ATTENDANCE_SHEET);
  const lastRow = attendanceSheet.getLastRow();
  if (lastRow < 2) return;
  const staleRows = attendanceSheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(function (row, index) {
      return rosterById.has(String(row[0])) ? null : index + 2;
    })
    .filter(function (row) { return row !== null; });
  staleRows.reverse().forEach(function (row) {
    attendanceSheet.deleteRow(row);
  });
}

function getAttendance_() {
  const membersSheet = getSheet_(MEMBERS_SHEET);
  const attendanceSheet = getSheet_(ATTENDANCE_SHEET);
  const memberRows = membersSheet.getDataRange().getValues().slice(1);
  const attendanceRows = attendanceSheet.getDataRange().getValues().slice(1);
  if (memberRows.length > 5000 || attendanceRows.length > 5000) {
    throw new Error("The roster or attendance list exceeds the 5,000 guest limit.");
  }

  const members = memberRows
    .filter(function (row) { return row[0] && row[1] && row[2]; })
    .map(function (row) {
      return { id: String(row[0]), name: String(row[1]), token: String(row[2]) };
    });
  const attendance = attendanceRows
    .filter(function (row) { return row[0] && row[1] && row[2]; })
    .map(function (row) {
      return {
        id: String(row[0]),
        name: String(row[1]),
        checkedInAt: toIso_(row[2]),
      };
    });
  return { members: members, attendance: attendance };
}

function checkIn_(token) {
  if (!UUID_PATTERN.test(token)) throw new Error("This QR code is not valid.");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = getSpreadsheet_();
    const membersSheet = spreadsheet.getSheetByName(MEMBERS_SHEET);
    const attendanceSheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET);
    if (!membersSheet || !attendanceSheet) {
      throw new Error("Run setupEventCheckin from the spreadsheet Apps Script project first.");
    }

    const memberRows = membersSheet.getDataRange().getValues();
    const member = memberRows.slice(1).find(function (row) {
      return String(row[2]) === token;
    });
    if (!member) throw new Error("This QR code is not in the synced roster.");

    const attendanceRows = attendanceSheet.getDataRange().getValues();
    const existing = attendanceRows.slice(1).find(function (row) {
      return String(row[0]) === String(member[0]);
    });
    if (existing) {
      return {
        status: "already_checked_in",
        name: String(member[1]),
        checkedInAt: toIso_(existing[2]),
      };
    }

    const checkedInAt = new Date();
    attendanceSheet.appendRow([member[0], member[1], checkedInAt]);
    SpreadsheetApp.flush();
    return {
      status: "checked_in",
      name: String(member[1]),
      checkedInAt: checkedInAt.toISOString(),
    };
  } finally {
    lock.releaseLock();
  }
}

function guestCheckinPage_(result) {
  const success = result.status === "checked_in" || result.status === "already_checked_in";
  const title = success
    ? result.status === "checked_in" ? "You're checked in!" : "Already checked in"
    : "Check-in unsuccessful";
  const message = success
    ? escapeHtml_(result.name) + (result.status === "checked_in"
      ? " has been added to the attendance and raffle list."
      : " is already on the attendance and raffle list.")
    : escapeHtml_(result.error || "Please ask event staff for help.");
  const color = success ? "#285d38" : "#913d2a";

  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + '</title><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f2;' +
    'font:16px system-ui,sans-serif;color:#242a25}.card{width:min(420px,calc(100% - 40px));' +
    'box-sizing:border-box;padding:32px;border:1px solid #e7ebe5;border-radius:16px;' +
    'background:white;text-align:center;box-shadow:0 14px 40px #22372a0d}' +
    'h1{font-size:24px;color:' + color + '}p{line-height:1.6;color:#536157}' +
    '</style></head><body><main class="card"><h1>' + title + '</h1><p>' + message +
    '</p><p>You can close this page now.</p></main></body></html>'
  );
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function removeMember_(id) {
  if (!UUID_PATTERN.test(id)) throw new Error("The member ID is invalid.");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = getSpreadsheet_();
    const membersSheet = spreadsheet.getSheetByName(MEMBERS_SHEET);
    const attendanceSheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET);
    if (!membersSheet || !attendanceSheet) {
      throw new Error("Run setupEventCheckin from the spreadsheet Apps Script project first.");
    }

    removeRowsById_(attendanceSheet, id);
    removeRowsById_(membersSheet, id);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { removed: true };
}

function removeRowsById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const matchingRows = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .getValues()
    .map(function (row, index) {
      return String(row[0]) === id ? index + 2 : null;
    })
    .filter(function (row) { return row !== null; });
  matchingRows.reverse().forEach(function (row) {
    sheet.deleteRow(row);
  });
}

function isMember_(member) {
  return (
    member &&
    typeof member.id === "string" &&
    UUID_PATTERN.test(member.id) &&
    typeof member.name === "string" &&
    member.name.trim().length > 0 &&
    member.name.length <= 100 &&
    typeof member.token === "string" &&
    UUID_PATTERN.test(member.token)
  );
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  if (!id) throw new Error("Run setupEventCheckin from the spreadsheet Apps Script project first.");
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error("Missing " + name + " sheet. Run setupEventCheckin again.");
  return sheet;
}

function ensureSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (existing.every(function (value) { return !value; })) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  } else if (headers.some(function (header, index) { return existing[index] !== header; })) {
    throw new Error("The " + name + " sheet already exists with different headers.");
  }
  return sheet;
}

function constantTimeEquals_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function toIso_(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function jsonp_(callback, value) {
  const safeCallback = /^__eventSheet_[a-f0-9]{32}$/.test(callback)
    ? callback
    : "__eventSheet_invalid";
  const output = ContentService.createTextOutput(
    safeCallback + "(" + JSON.stringify(value) + ");"
  );
  output.setMimeType(ContentService.MimeType.JAVASCRIPT);
  return output;
}
