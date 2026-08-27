(() => {
  "use strict";

  const STORAGE_KEY = "jobTracker.applications";
  const DRIVE_FILE_ID_KEY = "jobTracker.driveFileId";
  const DRIVE_LAST_SYNC_KEY = "jobTracker.lastSyncedAt";

  // Create an OAuth 2.0 Client ID (Web application) in Google Cloud Console
  // and paste it here. Add your app's URL as an Authorized JavaScript origin.
  const DRIVE_CONFIG = {
    CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",
    SCOPE: "https://www.googleapis.com/auth/drive.file",
    FILE_NAME: "job-tracker-data.json",
  };

  const STAGES = [
    { id: "applied", label: "Applied", color: "var(--stage-applied)" },
    { id: "oa", label: "Online Assessment", color: "var(--stage-oa)" },
    { id: "phone", label: "Phone Screen", color: "var(--stage-phone)" },
    { id: "interview", label: "Interview", color: "var(--stage-interview)" },
    { id: "offer", label: "Offer", color: "var(--stage-offer)" },
    { id: "accepted", label: "Accepted", color: "var(--stage-accepted)" },
    { id: "rejected", label: "Rejected", color: "var(--stage-rejected)" },
    { id: "withdrawn", label: "Withdrawn", color: "var(--stage-withdrawn)" },
  ];
  const stageMap = Object.fromEntries(STAGES.map((s) => [s.id, s]));

  /** @typedef {{id:string, company:string, position:string, dateApplied:string, stage:string, location:string, url:string, source:string, salary:string, contact:string, followUpDate:string, notes:string, updatedAt:string}} Application */

  /** @type {Application[]} */
  let applications = loadApplications();
  let activeStageFilter = "all";
  let searchQuery = "";
  let sortMode = "dateDesc";

  // ---------- Persistence ----------
  function loadApplications() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveApplications() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
    scheduleDriveSync();
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- DOM refs ----------
  const cardGrid = document.getElementById("cardGrid");
  const emptyState = document.getElementById("emptyState");
  const statsEl = document.getElementById("stats");
  const stageFiltersEl = document.getElementById("stageFilters");
  const searchInput = document.getElementById("searchInput");
  const sortSelect = document.getElementById("sortSelect");
  const driveSignInBtn = document.getElementById("driveSignInBtn");
  const syncStatusEl = document.getElementById("syncStatus");

  const appModal = document.getElementById("appModal");
  const appForm = document.getElementById("appForm");
  const modalTitle = document.getElementById("modalTitle");
  const deleteBtn = document.getElementById("deleteBtn");

  const fields = {
    id: document.getElementById("appId"),
    company: document.getElementById("company"),
    position: document.getElementById("position"),
    dateApplied: document.getElementById("dateApplied"),
    stage: document.getElementById("stage"),
    location: document.getElementById("location"),
    url: document.getElementById("url"),
    source: document.getElementById("source"),
    salary: document.getElementById("salary"),
    contact: document.getElementById("contact"),
    followUpDate: document.getElementById("followUpDate"),
    notes: document.getElementById("notes"),
  };

  // ---------- Init ----------
  function init() {
    fields.stage.innerHTML = STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
    stageFiltersEl.innerHTML =
      `<button class="chip active" data-stage="all">All</button>` +
      STAGES.map((s) => `<button class="chip" data-stage="${s.id}">${s.label}</button>`).join("");

    document.getElementById("addBtn").addEventListener("click", () => openModal());
    document.getElementById("emptyAddBtn").addEventListener("click", () => openModal());
    document.getElementById("cancelBtn").addEventListener("click", () => appModal.close());
    deleteBtn.addEventListener("click", onDelete);
    appForm.addEventListener("submit", onSave);

    stageFiltersEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      activeStageFilter = btn.dataset.stage;
      [...stageFiltersEl.children].forEach((c) => c.classList.toggle("active", c === btn));
      render();
    });

    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      render();
    });

    sortSelect.addEventListener("change", (e) => {
      sortMode = e.target.value;
      render();
    });

    document.getElementById("exportBtn").addEventListener("click", exportData);
    document.getElementById("importBtn").addEventListener("click", () =>
      document.getElementById("importFile").click()
    );
    document.getElementById("importFile").addEventListener("change", importData);

    driveSignInBtn.addEventListener("click", handleDriveButtonClick);
    if (isDriveConfigured() && localStorage.getItem(DRIVE_FILE_ID_KEY)) {
      waitForGoogleScript(() => {
        initTokenClient();
        tokenClient.requestAccessToken({ prompt: "none" });
      });
    }

    render();
  }

  // ---------- Google Drive sync ----------
  let tokenClient = null;
  let accessToken = null;
  let syncTimer = null;

  function isDriveConfigured() {
    return !DRIVE_CONFIG.CLIENT_ID.startsWith("YOUR_");
  }

  function waitForGoogleScript(cb, attempts = 0) {
    if (window.google && google.accounts && google.accounts.oauth2) return cb();
    if (attempts > 50) return;
    setTimeout(() => waitForGoogleScript(cb, attempts + 1), 200);
  }

  function initTokenClient() {
    if (tokenClient) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CONFIG.CLIENT_ID,
      scope: DRIVE_CONFIG.SCOPE,
      callback: async (resp) => {
        if (resp.error) {
          if (resp.error !== "interaction_required" && resp.error !== "immediate_failed") {
            updateSyncStatus("Sign-in failed");
          }
          return;
        }
        accessToken = resp.access_token;
        driveSignInBtn.textContent = "Sign out";
        await onSignedIn();
      },
    });
  }

  function handleDriveButtonClick() {
    if (accessToken) {
      signOutOfDrive();
      return;
    }
    if (!isDriveConfigured()) {
      alert(
        "Google Drive sync isn't configured yet.\n\nCreate an OAuth Client ID in Google Cloud Console and set DRIVE_CONFIG.CLIENT_ID in app.js."
      );
      return;
    }
    waitForGoogleScript(() => {
      initTokenClient();
      tokenClient.requestAccessToken({ prompt: "consent" });
    });
  }

  function signOutOfDrive() {
    if (accessToken && window.google) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    driveSignInBtn.textContent = "Sign in with Google";
    updateSyncStatus("");
  }

  function updateSyncStatus(text) {
    syncStatusEl.textContent = text;
  }

  function driveFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
    });
  }

  async function onSignedIn() {
    updateSyncStatus("Connecting…");
    try {
      await ensureDriveFile();
      await pullFromDrive();
      updateSyncStatus("Synced " + new Date().toLocaleTimeString());
    } catch (err) {
      console.error(err);
      updateSyncStatus("Sync error");
    }
  }

  async function ensureDriveFile() {
    let fileId = localStorage.getItem(DRIVE_FILE_ID_KEY);
    if (fileId) return fileId;

    const q = encodeURIComponent(`name='${DRIVE_CONFIG.FILE_NAME}' and trashed=false`);
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`
    );
    const data = await res.json();
    fileId = data.files && data.files.length ? data.files[0].id : await createDriveFile();
    localStorage.setItem(DRIVE_FILE_ID_KEY, fileId);
    return fileId;
  }

  async function createDriveFile() {
    const boundary = "jobtracker-boundary";
    const metadata = { name: DRIVE_CONFIG.FILE_NAME, mimeType: "application/json" };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(applications)}\r\n` +
      `--${boundary}--`;

    const res = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
    const data = await res.json();
    return data.id;
  }

  async function pullFromDrive() {
    const fileId = localStorage.getItem(DRIVE_FILE_ID_KEY);
    if (!fileId) return;

    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error("Could not reach Drive");
    const text = await res.text();
    const remote = text ? JSON.parse(text) : [];

    const lastSynced = Number(localStorage.getItem(DRIVE_LAST_SYNC_KEY) || 0);
    const hasLocalChanges = applications.some((a) => new Date(a.updatedAt).getTime() > lastSynced);

    if (applications.length && hasLocalChanges) {
      const useRemote = confirm(
        `Cloud has ${remote.length} application(s) and this device has unsynced local changes.\n\n` +
          `Load the cloud copy and discard local changes on this device? Cancel keeps this device's data (it will overwrite the cloud copy on your next edit).`
      );
      if (!useRemote) return;
    }

    applications = remote;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
    localStorage.setItem(DRIVE_LAST_SYNC_KEY, Date.now().toString());
    render();
  }

  function scheduleDriveSync() {
    if (!accessToken) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushToDrive, 400);
  }

  async function pushToDrive() {
    const fileId = localStorage.getItem(DRIVE_FILE_ID_KEY);
    if (!fileId || !accessToken) return;
    updateSyncStatus("Syncing…");
    try {
      await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(applications) }
      );
      localStorage.setItem(DRIVE_LAST_SYNC_KEY, Date.now().toString());
      updateSyncStatus("Synced " + new Date().toLocaleTimeString());
    } catch (err) {
      console.error(err);
      updateSyncStatus("Sync failed");
    }
  }

  // ---------- Modal ----------
  function openModal(app) {
    appForm.reset();
    if (app) {
      modalTitle.textContent = "Edit Application";
      deleteBtn.classList.remove("hidden");
      fields.id.value = app.id;
      fields.company.value = app.company;
      fields.position.value = app.position;
      fields.dateApplied.value = app.dateApplied;
      fields.stage.value = app.stage;
      fields.location.value = app.location || "";
      fields.url.value = app.url || "";
      fields.source.value = app.source || "";
      fields.salary.value = app.salary || "";
      fields.contact.value = app.contact || "";
      fields.followUpDate.value = app.followUpDate || "";
      fields.notes.value = app.notes || "";
    } else {
      modalTitle.textContent = "New Application";
      deleteBtn.classList.add("hidden");
      fields.id.value = "";
      fields.dateApplied.value = new Date().toISOString().slice(0, 10);
      fields.stage.value = "applied";
    }
    appModal.showModal();
  }

  function onSave(e) {
    e.preventDefault();
    if (!fields.company.value.trim() || !fields.position.value.trim() || !fields.dateApplied.value) {
      return;
    }
    const id = fields.id.value || uid();
    const record = {
      id,
      company: fields.company.value.trim(),
      position: fields.position.value.trim(),
      dateApplied: fields.dateApplied.value,
      stage: fields.stage.value,
      location: fields.location.value.trim(),
      url: fields.url.value.trim(),
      source: fields.source.value.trim(),
      salary: fields.salary.value.trim(),
      contact: fields.contact.value.trim(),
      followUpDate: fields.followUpDate.value,
      notes: fields.notes.value.trim(),
      updatedAt: new Date().toISOString(),
    };

    const idx = applications.findIndex((a) => a.id === id);
    if (idx >= 0) applications[idx] = record;
    else applications.push(record);

    saveApplications();
    appModal.close();
    render();
  }

  function onDelete() {
    const id = fields.id.value;
    if (!id) return;
    if (!confirm("Delete this application? This can't be undone.")) return;
    applications = applications.filter((a) => a.id !== id);
    saveApplications();
    appModal.close();
    render();
  }

  // ---------- Export / Import ----------
  function exportData() {
    const blob = new Blob([JSON.stringify(applications, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `job-applications-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error("Invalid file");
        const existingIds = new Set(applications.map((a) => a.id));
        const merged = incoming.filter((a) => a && a.id && !existingIds.has(a.id));
        applications = applications.concat(merged);
        saveApplications();
        render();
        alert(`Imported ${merged.length} application(s).`);
      } catch (err) {
        alert("Could not import file: " + err.message);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  // ---------- Render ----------
  function render() {
    renderStats();
    renderCards();
  }

  function renderStats() {
    const total = applications.length;
    const counts = {};
    STAGES.forEach((s) => (counts[s.id] = 0));
    applications.forEach((a) => {
      if (counts[a.stage] !== undefined) counts[a.stage]++;
    });

    const activePipeline = counts.applied + counts.oa + counts.phone + counts.interview;

    const cards = [
      { label: "Total", num: total },
      { label: "In Progress", num: activePipeline },
      { label: "Interviews", num: counts.interview },
      { label: "Offers", num: counts.offer + counts.accepted },
      { label: "Rejected", num: counts.rejected },
    ];

    statsEl.innerHTML = cards
      .map((c) => `<div class="stat-card"><div class="num">${c.num}</div><div class="label">${c.label}</div></div>`)
      .join("");
  }

  function renderCards() {
    let list = applications.slice();

    if (activeStageFilter !== "all") {
      list = list.filter((a) => a.stage === activeStageFilter);
    }
    if (searchQuery) {
      list = list.filter(
        (a) =>
          a.company.toLowerCase().includes(searchQuery) ||
          a.position.toLowerCase().includes(searchQuery)
      );
    }

    list.sort((a, b) => {
      switch (sortMode) {
        case "dateAsc":
          return a.dateApplied.localeCompare(b.dateApplied);
        case "company":
          return a.company.localeCompare(b.company);
        case "stage":
          return STAGES.findIndex((s) => s.id === a.stage) - STAGES.findIndex((s) => s.id === b.stage);
        case "dateDesc":
        default:
          return b.dateApplied.localeCompare(a.dateApplied);
      }
    });

    emptyState.classList.toggle("hidden", applications.length > 0);
    cardGrid.classList.toggle("hidden", applications.length === 0);

    cardGrid.innerHTML = list.map(cardTemplate).join("");

    cardGrid.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", () => {
        const app = applications.find((a) => a.id === el.dataset.id);
        if (app) openModal(app);
      });
    });
  }

  function cardTemplate(a) {
    const stage = stageMap[a.stage] || STAGES[0];
    const meta = [];
    if (a.location) meta.push(`<span>📍 <strong>${escapeHtml(a.location)}</strong></span>`);
    if (a.salary) meta.push(`<span>💰 <strong>${escapeHtml(a.salary)}</strong></span>`);
    if (a.source) meta.push(`<span>🔗 <strong>${escapeHtml(a.source)}</strong></span>`);
    if (a.contact) meta.push(`<span>👤 <strong>${escapeHtml(a.contact)}</strong></span>`);
    if (a.followUpDate) meta.push(`<span>⏰ Follow up: <strong>${formatDate(a.followUpDate)}</strong></span>`);

    return `
      <div class="card" data-id="${a.id}">
        <div class="card-top">
          <div>
            <div class="card-company">${escapeHtml(a.company)}</div>
            <div class="card-position">${escapeHtml(a.position)}</div>
          </div>
          <span class="badge" style="background:${stage.color}">${stage.label}</span>
        </div>
        <div class="card-meta">
          <span>📅 Submitted <strong>${formatDate(a.dateApplied)}</strong></span>
          ${meta.join("")}
        </div>
        ${a.notes ? `<div class="card-notes">${escapeHtml(a.notes)}</div>` : ""}
      </div>
    `;
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  init();
})();
