const draft = { participants: [], exclusions: [] };
const $ = (selector) => document.querySelector(selector);
const screens = document.querySelectorAll(".screen");
const toast = $("#toast");
let currentEventId = null;
let selectedParticipantId = null;
let participantSession = null;
let adminCredentials = null;
let currentParticipantData = null;
let pollTimer = null;
let claimPhotos = [null, null, null, null];
let editPhotoChanges = [undefined, undefined, undefined, undefined];
const MAX_PHOTO_BYTES = 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function id() {
  return crypto.randomUUID();
}

function showScreen(screenId) {
  screens.forEach((screen) => screen.classList.toggle("active", screen.id === screenId));
  $("#home-button").classList.toggle("hidden", screenId === "setup-screen");
  $("#maintenance-panel").classList.toggle("hidden", screenId !== "setup-screen");
  clearInterval(pollTimer);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!PHOTO_TYPES.has(file.type)) {
      reject(new Error("Choose a JPG, PNG, WebP or GIF image"));
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      reject(new Error("Each photo must be 1 MB or smaller"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const [, data] = String(reader.result).split(",");
      resolve({ mime: file.type, data });
    };
    reader.onerror = () => reject(new Error("That photo could not be read"));
    reader.readAsDataURL(file);
  });
}

function photoDataUrl(photo) {
  return photo ? `data:${photo.mime};base64,${photo.data}` : "";
}

function showPhotoPreview(container, photo) {
  if (typeof container === "string") container = $(container);
  container.classList.toggle("hidden", !photo);
  const image = container.querySelector("img");
  if (photo) image.src = photoDataUrl(photo);
  else image.removeAttribute("src");
}

async function api(action, data = {}) {
  const response = await fetch("/api/secret-santa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
}

function personById(personId) {
  return draft.participants.find((person) => person.id === personId);
}

function renderDraft() {
  const list = $("#name-list");
  list.replaceChildren();
  $("#empty-state").classList.toggle("hidden", draft.participants.length > 0);
  $("#name-count").textContent = draft.participants.length;

  draft.participants.forEach((person) => {
    const item = document.createElement("li");
    item.className = "name-item";
    const initial = document.createElement("span");
    initial.className = "name-initial";
    initial.textContent = person.name[0].toUpperCase();
    const name = document.createElement("strong");
    name.textContent = person.name;
    const remove = document.createElement("button");
    remove.className = "remove-button";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${person.name}`);
    remove.onclick = () => {
      draft.participants = draft.participants.filter((entry) => entry.id !== person.id);
      draft.exclusions = draft.exclusions.filter((pair) => !pair.includes(person.id));
      renderDraft();
    };
    item.append(initial, name, remove);
    list.append(item);
  });

  const remaining = 3 - draft.participants.length;
  $("#create-button").disabled = remaining > 0;
  $("#setup-hint").textContent = remaining > 0
    ? `Add ${remaining} more ${remaining === 1 ? "person" : "people"}`
    : "Ready to create the family link";
  renderRules();
}

function renderRules() {
  $("#rules-section").classList.toggle("hidden", draft.participants.length < 2);
  for (const select of [$("#couple-one"), $("#couple-two")]) {
    select.replaceChildren();
    draft.participants.forEach((person) => {
      const option = document.createElement("option");
      option.value = person.id;
      option.textContent = person.name;
      select.append(option);
    });
  }
  if (draft.participants.length > 1) $("#couple-two").selectedIndex = 1;

  const list = $("#couple-list");
  list.replaceChildren();
  draft.exclusions.forEach(([firstId, secondId]) => {
    const first = personById(firstId);
    const second = personById(secondId);
    const item = document.createElement("li");
    item.className = "couple-chip";
    item.append(document.createTextNode(`${first.name} & ${second.name}`));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.onclick = () => {
      draft.exclusions = draft.exclusions.filter((pair) => pair !== draft.exclusions.find((entry) => entry[0] === firstId && entry[1] === secondId));
      renderRules();
    };
    item.append(remove);
    list.append(item);
  });
}

function sessionKey(eventId) {
  return `mohr-ry-match-session-${eventId}`;
}

function buildEventUrl(eventId) {
  const url = new URL(window.location.href);
  url.search = `?event=${encodeURIComponent(eventId)}`;
  url.hash = "";
  return url.toString();
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  notify("Copied!");
}

async function loadAdmin() {
  const data = await api("admin-status", adminCredentials);
  currentEventId = data.event.id;
  $("#admin-title").textContent = data.event.name;
  $("#join-link").value = buildEventUrl(data.event.id);
  $("#claimed-count").textContent = data.claimedCount;
  $("#admin-total").textContent = data.includedCount;
  $("#claim-progress").style.width = `${data.includedCount ? data.claimedCount / data.includedCount * 100 : 0}%`;

  const list = $("#admin-status-list");
  list.replaceChildren();
  data.participants.forEach((person) => {
    const item = document.createElement("div");
    item.className = "status-person";
    item.classList.toggle("excluded-person", !person.included);
    const initial = document.createElement("span");
    initial.className = "name-initial";
    initial.textContent = person.name[0].toUpperCase();
    const name = document.createElement("strong");
    name.textContent = person.name;
    const state = document.createElement("span");
    state.className = !person.included ? "excluded-status" : person.claimed ? "joined-status" : "waiting-status";
    state.textContent = !person.included ? "Opted out" : person.claimed ? "✓ Joined" : "Waiting";
    item.append(initial, name, state);
    if (data.event.status === "waiting") {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "participation-button";
      toggle.textContent = person.included ? "Exclude" : "Restore";
      toggle.setAttribute("aria-label", `${person.included ? "Exclude" : "Restore"} ${person.name}`);
      toggle.onclick = () => setParticipation(person.id, !person.included, toggle);
      item.append(toggle);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-participant-button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${person.name} from this event`);
      remove.onclick = () => removeParticipant(person.id, person.name, remove);
      item.append(remove);
    }
    list.append(item);
  });

  $("#add-participant-form").classList.toggle("hidden", data.event.status !== "waiting");

  const ready = data.includedCount >= 3 && data.claimedCount === data.includedCount && data.event.status === "waiting";
  $("#draw-now-button").disabled = !ready;
  $("#draw-now-button").classList.toggle("hidden", data.event.status === "drawn");
  $("#draw-note").textContent = data.event.status === "drawn"
    ? "The draw is complete. Everyone can now see their own match."
    : data.includedCount < 3 ? "At least 3 included people are required."
      : ready ? "Everyone included is here—the draw is ready." : "Everyone included must join before the draw.";
  showScreen("admin-screen");
  if (data.event.status === "waiting") pollTimer = setInterval(() => loadAdmin().catch(() => {}), 15000);
}

async function loadJoin(eventId) {
  const data = await api("event-info", { eventId });
  currentEventId = eventId;
  $("#join-title").textContent = data.event.name;
  const storedSession = localStorage.getItem(sessionKey(eventId));
  if (storedSession) {
    participantSession = storedSession;
    try {
      await loadParticipant();
      return;
    } catch {
      localStorage.removeItem(sessionKey(eventId));
      participantSession = null;
    }
  }

  const grid = $("#claim-grid");
  grid.replaceChildren();
  data.participants.filter((person) => person.included && !person.claimed).forEach((person) => {
    const button = document.createElement("button");
    button.className = "claim-button";
    button.type = "button";
    button.textContent = person.name;
    button.onclick = () => choosePerson(person);
    grid.append(button);
  });
  if (!grid.children.length) {
    const message = document.createElement("p");
    message.className = "all-claimed";
    message.textContent = "Everyone has joined. If that includes you, sign in with your PIN below.";
    grid.append(message);
  }
  fillLoginNames(data.participants);
  showScreen("join-screen");
}

function choosePerson(person) {
  selectedParticipantId = person.id;
  claimPhotos = [null, null, null, null];
  document.querySelectorAll(".claim-photo-input").forEach((input) => { input.value = ""; });
  document.querySelectorAll("[id^='claim-photo-preview-']").forEach((preview) => showPhotoPreview(preview, null));
  [1, 2, 3, 4].forEach((number) => { $(`#preference-${number}`).value = ""; });
  $("#profile-name").textContent = person.name;
  $("#claim-panel").classList.add("hidden");
  $("#profile-form").classList.remove("hidden");
  $(".login-panel").classList.add("hidden");
  $("#pin-input").focus();
}

function fillLoginNames(participants) {
  const select = $("#login-name");
  select.replaceChildren();
  participants.filter((person) => person.claimed).forEach((person) => {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = person.name;
    select.append(option);
  });
}

async function loadParticipant() {
  const data = await api("participant-view", {
    eventId: currentEventId,
    sessionToken: participantSession
  });
  currentParticipantData = data;
  $("#participant-name").textContent = data.participant.name;
  const inputs = document.querySelectorAll(".edit-preference");
  inputs.forEach((input) => { input.value = ""; });
  data.participant.preferences.forEach((preference, index) => { inputs[index].value = preference; });
  editPhotoChanges = [undefined, undefined, undefined, undefined];
  document.querySelectorAll(".edit-photo-input").forEach((input) => { input.value = ""; });
  document.querySelectorAll(".edit-photo-preview").forEach((preview, index) => {
    showPhotoPreview(preview, data.participant.photos[index] || null);
  });

  $("#waiting-view").classList.toggle("hidden", data.event.status === "drawn");
  $("#opted-out-view").classList.toggle("hidden", data.participant.included);
  $("#waiting-view").classList.toggle("hidden", data.event.status === "drawn" || !data.participant.included);
  $("#result-view").classList.toggle("hidden", data.event.status !== "drawn" || !data.participant.included);
  $("#edit-preferences-form").classList.toggle("hidden", !data.participant.included);
  if (data.event.status === "drawn" && data.participant.included) {
    $("#recipient-name").textContent = data.recipient.name;
    const list = $("#recipient-preferences");
    list.replaceChildren();
    data.recipient.preferences.forEach((preference, index) => {
      const photo = data.recipient.photos[index];
      if (!preference && !photo) return;
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = preference || "Reference image";
      item.append(text);
      if (photo) {
        const image = document.createElement("img");
        image.className = "recipient-photo";
        image.alt = `Reference image for preference ${index + 1}`;
        image.src = photoDataUrl(photo);
        item.append(image);
      }
      list.append(item);
    });
    $("#no-recipient-preferences").classList.toggle("hidden", list.children.length > 0);
  }
  showScreen("participant-screen");
  if (data.event.status !== "drawn") pollTimer = setInterval(() => loadParticipant().catch(() => {}), 15000);
}

async function setParticipation(participantId, included, button) {
  button.disabled = true;
  try {
    await api("set-participation", {
      ...adminCredentials,
      participantId,
      included
    });
    await loadAdmin();
    notify(included ? "Participant restored" : "Participant excluded from the draw");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

async function removeParticipant(participantId, name, button) {
  if (!confirm(`Remove ${name} from this event? This deletes their profile and can't be undone.`)) return;
  button.disabled = true;
  try {
    await api("remove-participant", {
      ...adminCredentials,
      participantId
    });
    await loadAdmin();
    notify(`${name} was removed from the event`);
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

$("#add-participant-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#add-participant-name");
  const name = input.value.trim().replace(/\s+/g, " ");
  if (!name) return;
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    await api("add-participant", { ...adminCredentials, name });
    input.value = "";
    await loadAdmin();
    notify(`${name} was added to the event`);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    input.focus();
  }
});

function showError(message) {
  $("#error-message").textContent = message;
  showScreen("error-screen");
}

$("#name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#name-input");
  const name = input.value.trim().replace(/\s+/g, " ");
  if (draft.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) {
    notify("That name is already on the list");
    return;
  }
  draft.participants.push({ id: id(), name });
  input.value = "";
  renderDraft();
  input.focus();
});

$("#couple-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const first = $("#couple-one").value;
  const second = $("#couple-two").value;
  if (first === second) return notify("Choose two different people");
  const exists = draft.exclusions.some(([a, b]) => (a === first && b === second) || (a === second && b === first));
  if (exists) return notify("That rule is already added");
  draft.exclusions.push([first, second]);
  renderRules();
});

$("#create-button").addEventListener("click", async () => {
  const button = $("#create-button");
  button.disabled = true;
  button.textContent = "Creating…";
  try {
    const result = await api("create-event", {
      name: $("#event-name").value.trim(),
      participants: draft.participants,
      exclusions: draft.exclusions
    });
    adminCredentials = { eventId: result.eventId, adminToken: result.adminToken };
    history.replaceState(null, "", `?admin=${encodeURIComponent(result.eventId)}#${result.adminToken}`);
    await loadAdmin();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = "Create the event <span>→</span>";
  }
});

$("#copy-link-button").onclick = () => copyText($("#join-link").value);
$("#reset-event-button").onclick = () => {
  $("#reset-confirmation").value = "";
  $("#confirm-reset-button").disabled = true;
  $("#reset-dialog").showModal();
  $("#reset-confirmation").focus();
};
$("#reset-confirmation").addEventListener("input", (event) => {
  $("#confirm-reset-button").disabled = event.target.value !== "RESET";
});
$("#cancel-reset-button").onclick = () => $("#reset-dialog").close();
$("#reset-dialog").addEventListener("click", (event) => {
  if (event.target === $("#reset-dialog")) $("#reset-dialog").close();
});
$("#confirm-reset-button").addEventListener("click", async () => {
  const button = $("#confirm-reset-button");
  button.disabled = true;
  button.textContent = "Resetting…";
  try {
    await api("reset-event", adminCredentials);
    $("#reset-dialog").close();
    await loadAdmin();
    notify("The event has been reset");
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Reset everything";
    $("#reset-confirmation").value = "";
    button.disabled = true;
  }
});

$("#delete-event-button").onclick = () => {
  $("#delete-confirmation").value = "";
  $("#confirm-delete-button").disabled = true;
  $("#delete-dialog").showModal();
  $("#delete-confirmation").focus();
};
$("#delete-confirmation").addEventListener("input", (event) => {
  $("#confirm-delete-button").disabled = event.target.value !== "DELETE";
});
$("#cancel-delete-button").onclick = () => $("#delete-dialog").close();
$("#delete-dialog").addEventListener("click", (event) => {
  if (event.target === $("#delete-dialog")) $("#delete-dialog").close();
});
$("#confirm-delete-button").addEventListener("click", async () => {
  const button = $("#confirm-delete-button");
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    await api("delete-event", adminCredentials);
    localStorage.removeItem(sessionKey(adminCredentials.eventId));
    window.location.href = "./";
  } catch (error) {
    notify(error.message);
    button.textContent = "Delete permanently";
  }
});

$("#clear-all-confirmation").addEventListener("input", (event) => {
  $("#clear-all-button").disabled = event.target.value !== "CLEAR ALL EVENTS";
});
$("#clear-all-button").addEventListener("click", async () => {
  if (!confirm("This will erase every event saved by this deployment. Continue?")) return;
  const button = $("#clear-all-button");
  button.disabled = true;
  button.textContent = "Clearing all data…";
  try {
    const result = await api("clear-all-events", {
      cleanupKey: $("#cleanup-key").value
    });
    Object.keys(localStorage)
      .filter((key) => key.startsWith("mohr-ry-match-session-") || key.startsWith("merry-match-session-"))
      .forEach((key) => localStorage.removeItem(key));
    $("#cleanup-key").value = "";
    $("#clear-all-confirmation").value = "";
    notify(`${result.deleted} saved records deleted`);
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = "Clear all events";
    button.disabled = true;
  }
});
$("#draw-now-button").addEventListener("click", async () => {
  if (!confirm("Draw the names now? The participant list and couple rules cannot be changed afterward.")) return;
  const button = $("#draw-now-button");
  button.disabled = true;
  button.textContent = "Drawing…";
  try {
    await api("draw", adminCredentials);
    await loadAdmin();
    notify("The draw is complete!");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
    button.innerHTML = "Draw the names <span>✦</span>";
  }
});

$("#back-to-names").onclick = () => {
  selectedParticipantId = null;
  $("#profile-form").classList.add("hidden");
  $("#claim-panel").classList.remove("hidden");
  $(".login-panel").classList.remove("hidden");
};

$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const preferences = [1, 2, 3, 4].map((number) => $(`#preference-${number}`).value.trim());
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await api("claim", {
      eventId: currentEventId,
      participantId: selectedParticipantId,
      pin: $("#pin-input").value,
      preferences,
      photos: claimPhotos
    });
    participantSession = result.sessionToken;
    localStorage.setItem(sessionKey(currentEventId), participantSession);
    await loadParticipant();
  } catch (error) {
    notify(error.message);
    button.disabled = false;
    button.innerHTML = "Save my private profile <span>→</span>";
  }
});

$("#show-login-button").onclick = () => {
  $("#claim-panel").classList.add("hidden");
  $(".login-panel").classList.add("hidden");
  $("#login-form").classList.remove("hidden");
};
$("#cancel-login-button").onclick = () => {
  $("#login-form").classList.add("hidden");
  $("#claim-panel").classList.remove("hidden");
  $(".login-panel").classList.remove("hidden");
};
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("login", {
      eventId: currentEventId,
      participantId: $("#login-name").value,
      pin: $("#login-pin").value
    });
    participantSession = result.sessionToken;
    localStorage.setItem(sessionKey(currentEventId), participantSession);
    await loadParticipant();
  } catch (error) {
    notify(error.message);
  }
});

$("#refresh-button").onclick = () => loadParticipant().catch((error) => notify(error.message));
$("#edit-preferences-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const preferences = [...document.querySelectorAll(".edit-preference")].map((input) => input.value.trim());
  try {
    await api("update-preferences", {
      eventId: currentEventId,
      sessionToken: participantSession,
      preferences,
      photoUpdates: Object.fromEntries(
        editPhotoChanges
          .map((photo, index) => [index, photo])
          .filter(([, photo]) => photo !== undefined)
      )
    });
    currentParticipantData.participant.preferences = preferences;
    editPhotoChanges.forEach((photo, index) => {
      if (photo !== undefined) currentParticipantData.participant.photos[index] = photo;
    });
    editPhotoChanges = [undefined, undefined, undefined, undefined];
    notify("Preferences updated");
    event.currentTarget.querySelector("details").open = false;
  } catch (error) {
    notify(error.message);
  }
});

document.querySelectorAll(".claim-photo-input").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const index = Number(event.target.dataset.photoIndex);
    const [file] = event.target.files;
    if (!file) return;
    try {
      claimPhotos[index] = await readPhoto(file);
      showPhotoPreview($(`#claim-photo-preview-${index + 1}`), claimPhotos[index]);
    } catch (error) {
      event.target.value = "";
      claimPhotos[index] = null;
      showPhotoPreview($(`#claim-photo-preview-${index + 1}`), null);
      notify(error.message);
    }
  });
});

document.querySelectorAll(".claim-remove-photo").forEach((button) => {
  button.onclick = () => {
    const index = Number(button.dataset.photoIndex);
    claimPhotos[index] = null;
    $(`#wish-photo-${index + 1}`).value = "";
    showPhotoPreview($(`#claim-photo-preview-${index + 1}`), null);
  };
});

document.querySelectorAll(".edit-photo-input").forEach((input) => {
  input.addEventListener("change", async (event) => {
    const index = Number(event.target.dataset.photoIndex);
    const [file] = event.target.files;
    if (!file) return;
    try {
      editPhotoChanges[index] = await readPhoto(file);
      showPhotoPreview(document.querySelectorAll(".edit-photo-preview")[index], editPhotoChanges[index]);
    } catch (error) {
      event.target.value = "";
      notify(error.message);
    }
  });
});

document.querySelectorAll(".edit-remove-photo").forEach((button) => {
  button.onclick = () => {
    const index = Number(button.dataset.photoIndex);
    editPhotoChanges[index] = null;
    document.querySelectorAll(".edit-photo-input")[index].value = "";
    showPhotoPreview(document.querySelectorAll(".edit-photo-preview")[index], null);
  };
});

$("#home-button").onclick = () => { window.location.href = "./"; };

async function boot() {
  renderDraft();
  const params = new URLSearchParams(window.location.search);
  const adminEventId = params.get("admin");
  const eventId = params.get("event");
  try {
    if (adminEventId && window.location.hash.length > 1) {
      adminCredentials = { eventId: adminEventId, adminToken: window.location.hash.slice(1) };
      await loadAdmin();
    } else if (eventId) {
      await loadJoin(eventId);
    } else {
      showScreen("setup-screen");
    }
  } catch (error) {
    showError(error.message);
  }
}

boot();
