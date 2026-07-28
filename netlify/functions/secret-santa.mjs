import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const STORE_NAME = "mohr-ry-match-events";
const LEGACY_STORE_NAMES = ["merry-match-events"];
const MAX_PARTICIPANTS = 50;
const MAX_PHOTO_BYTES = 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hashPin(pin, salt = token(16)) {
  const derived = await scrypt(pin, salt, 64);
  return { salt, hash: Buffer.from(derived).toString("hex") };
}

async function verifyPin(pin, salt, expectedHash) {
  const candidate = await hashPin(pin, salt);
  return safeEqual(candidate.hash, expectedHash);
}

function eventKey(eventId) {
  return `event:${eventId}`;
}

function participantKey(eventId, participantId) {
  return `participant:${eventId}:${participantId}`;
}

function assignmentKey(eventId, participantId) {
  return `assignment:${eventId}:${participantId}`;
}

function isIncluded(person) {
  return person.included !== false;
}

async function getJSON(store, key) {
  return store.get(key, { type: "json", consistency: "strong" });
}

function cleanName(value, max = 60) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
  return cleaned;
}

function validatePreferences(preferences) {
  if (!Array.isArray(preferences) || preferences.length > 4) return null;
  const padded = [...preferences, "", "", "", ""].slice(0, 4);
  const cleaned = padded.map((preference) => {
    if (typeof preference !== "string") return null;
    const value = preference.trim().replace(/\s+/g, " ");
    if (value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    return value;
  });
  return cleaned.every((preference) => preference !== null) ? cleaned : null;
}

function validatePhoto(photo, optional = true) {
  if (photo === undefined && optional) return undefined;
  if (photo === null) return null;
  if (!photo || typeof photo.mime !== "string" || typeof photo.data !== "string" || !PHOTO_TYPES.has(photo.mime)) {
    throw new ApiError("Choose a JPG, PNG, WebP or GIF image");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(photo.data)) throw new ApiError("The photo data is invalid");
  const padding = photo.data.endsWith("==") ? 2 : photo.data.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(photo.data.length * 3 / 4) - padding;
  if (bytes <= 0 || bytes > MAX_PHOTO_BYTES) throw new ApiError("Each photo must be 1 MB or smaller");
  return { mime: photo.mime, data: photo.data };
}

function validatePhotos(photos) {
  if (photos === undefined) return [null, null, null, null];
  if (!Array.isArray(photos) || photos.length !== 4) throw new ApiError("Invalid preference photos");
  return photos.map((photo) => validatePhoto(photo, false));
}

function profilePhotos(participant) {
  if (Array.isArray(participant.photos)) {
    return [...participant.photos, null, null, null, null].slice(0, 4);
  }
  return [participant.photo || null, null, null, null];
}

function profilePreferences(participant) {
  return validatePreferences(participant.preferences || []) || ["", "", "", ""];
}

function validateEventInput(payload) {
  const name = cleanName(payload.name);
  const participants = payload.participants;
  const exclusions = payload.exclusions;
  if (!name) return { error: "Enter an event name" };
  if (!Array.isArray(participants) || participants.length < 3 || participants.length > MAX_PARTICIPANTS) {
    return { error: `Add between 3 and ${MAX_PARTICIPANTS} people` };
  }
  if (!Array.isArray(exclusions)) return { error: "Invalid couple rules" };

  const ids = new Set();
  const names = new Set();
  const cleanedParticipants = [];
  for (const participant of participants) {
    const participantName = cleanName(participant?.name, 40);
    if (!participantName || typeof participant?.id !== "string" || participant.id.length > 80) {
      return { error: "Check the participant names" };
    }
    if (ids.has(participant.id) || names.has(participantName.toLowerCase())) {
      return { error: "Participant names must be unique" };
    }
    ids.add(participant.id);
    names.add(participantName.toLowerCase());
    cleanedParticipants.push({ id: participant.id, name: participantName, included: true });
  }

  const exclusionKeys = new Set();
  const cleanedExclusions = [];
  for (const pair of exclusions) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || !ids.has(pair[0]) || !ids.has(pair[1])) {
      return { error: "Check the couple rules" };
    }
    const key = [pair[0], pair[1]].sort().join(":");
    if (!exclusionKeys.has(key)) {
      exclusionKeys.add(key);
      cleanedExclusions.push(pair);
    }
  }
  return { name, participants: cleanedParticipants, exclusions: cleanedExclusions };
}

function randomIndex(max) {
  if (max <= 1) return 0;
  const range = 0x100000000;
  const limit = range - (range % max);
  let value;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % max;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function makeAssignments(participants, exclusions) {
  const ids = participants.map((person) => person.id);
  const blocked = new Set(exclusions.map((pair) => [...pair].sort().join(":")));
  const givers = shuffle(ids);
  const used = new Set();
  const assignments = new Map();

  function solve(index) {
    if (index === givers.length) return true;
    const giver = givers[index];
    const options = shuffle(ids.filter((recipient) =>
      recipient !== giver &&
      !used.has(recipient) &&
      !blocked.has([giver, recipient].sort().join(":"))));
    for (const recipient of options) {
      assignments.set(giver, recipient);
      used.add(recipient);
      if (solve(index + 1)) return true;
      assignments.delete(giver);
      used.delete(recipient);
    }
    return false;
  }
  return solve(0) ? assignments : null;
}

async function requireEvent(store, eventId) {
  if (typeof eventId !== "string" || eventId.length > 100) throw new ApiError("Invalid event", 400);
  const event = await getJSON(store, eventKey(eventId));
  if (!event) throw new ApiError("This event could not be found", 404);
  return event;
}

async function requireAdmin(store, payload) {
  const event = await requireEvent(store, payload.eventId);
  if (!safeEqual(digest(payload.adminToken || ""), event.adminTokenHash)) {
    throw new ApiError("This organizer link is invalid", 401);
  }
  return event;
}

async function requireParticipant(store, payload) {
  const event = await requireEvent(store, payload.eventId);
  const sessionHash = digest(payload.sessionToken || "");
  const states = await Promise.all(event.participants.map((person) => getJSON(store, participantKey(event.id, person.id))));
  const index = states.findIndex((state) => state?.claimed && safeEqual(sessionHash, state.sessionHash));
  if (index === -1) throw new ApiError("Your private session has expired. Sign in with your PIN.", 401);
  return { event, participant: states[index] };
}

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function createEvent(store, payload) {
  const valid = validateEventInput(payload);
  if (valid.error) throw new ApiError(valid.error);
  const eventId = token(12);
  const adminToken = token();
  const event = {
    id: eventId,
    name: valid.name,
    status: "waiting",
    participants: valid.participants,
    exclusions: valid.exclusions,
    adminTokenHash: digest(adminToken),
    createdAt: new Date().toISOString()
  };
  await Promise.all([
    store.setJSON(eventKey(eventId), event),
    ...event.participants.map((person) => store.setJSON(participantKey(eventId, person.id), {
      id: person.id,
      name: person.name,
      claimed: false,
      preferences: []
    }))
  ]);
  return { eventId, adminToken };
}

async function eventInfo(store, payload) {
  const event = await requireEvent(store, payload.eventId);
  const states = await Promise.all(event.participants.map((person) => getJSON(store, participantKey(event.id, person.id))));
  return {
    event: { id: event.id, name: event.name, status: event.status },
    participants: event.participants.map((person, index) => ({
      id: person.id,
      name: person.name,
      claimed: Boolean(states[index]?.claimed),
      included: isIncluded(person)
    }))
  };
}

async function claim(store, payload) {
  const event = await requireEvent(store, payload.eventId);
  if (event.status !== "waiting") throw new ApiError("The draw has already started");
  if (typeof payload.pin !== "string" || payload.pin.length < 6 || payload.pin.length > 80) {
    throw new ApiError("Your PIN or passphrase must be at least 6 characters");
  }
  const preferences = validatePreferences(payload.preferences);
  if (!preferences) throw new ApiError("Check your gift preferences");
  const photos = validatePhotos(payload.photos);
  const person = event.participants.find((entry) => entry.id === payload.participantId);
  if (!person) throw new ApiError("That participant is not in this event");
  if (!isIncluded(person)) throw new ApiError("The organizer has excluded that person from the draw", 409);
  const key = participantKey(event.id, person.id);
  const existing = await getJSON(store, key);
  if (existing?.claimed) throw new ApiError("That name has already been claimed", 409);

  const pinRecord = await hashPin(payload.pin);
  const sessionToken = token();
  await store.setJSON(key, {
    id: person.id,
    name: person.name,
    claimed: true,
    preferences,
    photos,
    pinSalt: pinRecord.salt,
    pinHash: pinRecord.hash,
    sessionHash: digest(sessionToken),
    claimedAt: new Date().toISOString()
  });
  return { sessionToken };
}

async function login(store, payload) {
  const event = await requireEvent(store, payload.eventId);
  const person = event.participants.find((entry) => entry.id === payload.participantId);
  if (!person) throw new ApiError("That person is not in this event");
  const key = participantKey(event.id, person.id);
  const state = await getJSON(store, key);
  if (!state?.claimed || !(await verifyPin(payload.pin || "", state.pinSalt, state.pinHash))) {
    throw new ApiError("The name or PIN is incorrect", 401);
  }
  const sessionToken = token();
  state.sessionHash = digest(sessionToken);
  await store.setJSON(key, state);
  return { sessionToken };
}

async function participantView(store, payload) {
  const { event, participant } = await requireParticipant(store, payload);
  const result = {
    event: { name: event.name, status: event.status },
    participant: {
      name: participant.name,
      preferences: profilePreferences(participant),
      photos: profilePhotos(participant),
      included: isIncluded(event.participants.find((person) => person.id === participant.id))
    }
  };
  if (event.status === "drawn" && result.participant.included) {
    const assignment = await getJSON(store, assignmentKey(event.id, participant.id));
    if (!assignment) throw new ApiError("Your assignment is not ready yet", 503);
    const recipient = await getJSON(store, participantKey(event.id, assignment.recipientId));
    result.recipient = {
      name: recipient.name,
      preferences: profilePreferences(recipient),
      photos: profilePhotos(recipient)
    };
  }
  return result;
}

async function updatePreferences(store, payload) {
  const preferences = validatePreferences(payload.preferences);
  if (!preferences) throw new ApiError("Check your gift preferences");
  const { event, participant } = await requireParticipant(store, payload);
  const photoUpdates = payload.photoUpdates ?? {};
  if (!photoUpdates || Array.isArray(photoUpdates) || typeof photoUpdates !== "object") {
    throw new ApiError("Invalid preference photos");
  }
  const photos = profilePhotos(participant);
  for (const [rawIndex, photo] of Object.entries(photoUpdates)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new ApiError("Invalid preference photo");
    photos[index] = validatePhoto(photo, false);
  }
  const eventPerson = event.participants.find((person) => person.id === participant.id);
  if (!isIncluded(eventPerson)) throw new ApiError("You are currently excluded from this draw", 409);
  participant.preferences = preferences;
  participant.photos = photos;
  delete participant.photo;
  await store.setJSON(participantKey(event.id, participant.id), participant);
  return { saved: true };
}

async function adminStatus(store, payload) {
  const event = await requireAdmin(store, payload);
  const states = await Promise.all(event.participants.map((person) => getJSON(store, participantKey(event.id, person.id))));
  const includedCount = event.participants.filter(isIncluded).length;
  return {
    event: { id: event.id, name: event.name, status: event.status },
    includedCount,
    claimedCount: states.filter((state, index) => isIncluded(event.participants[index]) && state?.claimed).length,
    participants: event.participants.map((person, index) => ({
      id: person.id,
      name: person.name,
      claimed: Boolean(states[index]?.claimed),
      included: isIncluded(person)
    }))
  };
}

async function setParticipation(store, payload) {
  const event = await requireAdmin(store, payload);
  if (event.status !== "waiting") throw new ApiError("Participation cannot change after the draw", 409);
  if (typeof payload.included !== "boolean") throw new ApiError("Invalid participation setting");
  const person = event.participants.find((entry) => entry.id === payload.participantId);
  if (!person) throw new ApiError("That participant is not in this event");
  person.included = payload.included;
  await store.setJSON(eventKey(event.id), event);
  return { saved: true };
}

async function resetEvent(store, payload) {
  const event = await requireAdmin(store, payload);
  await Promise.all(event.participants.flatMap((person) => [
    store.setJSON(participantKey(event.id, person.id), {
      id: person.id,
      name: person.name,
      claimed: false,
      preferences: []
    }),
    store.delete(assignmentKey(event.id, person.id))
  ]));
  event.status = "waiting";
  delete event.drawnAt;
  event.participants.forEach((person) => { person.included = true; });
  event.resetAt = new Date().toISOString();
  await store.setJSON(eventKey(event.id), event);
  return { reset: true };
}

async function deleteEvent(store, payload) {
  const event = await requireAdmin(store, payload);
  await Promise.all([
    ...event.participants.flatMap((person) => [
      store.delete(participantKey(event.id, person.id)),
      store.delete(assignmentKey(event.id, person.id))
    ]),
    store.delete(eventKey(event.id))
  ]);
  return { deleted: true };
}

async function deleteEveryKey(store) {
  const keys = [];
  for await (const page of store.list({ paginate: true })) {
    keys.push(...page.blobs.map((blob) => blob.key));
  }
  await Promise.all(keys.map((key) => store.delete(key)));
  return keys.length;
}

async function clearAllEvents(_store, payload) {
  const expectedKey = Netlify.env.get("DATA_CLEANUP_KEY");
  if (!expectedKey) throw new ApiError("All-event cleanup is not configured", 503);
  if (!safeEqual(payload.cleanupKey || "", expectedKey)) {
    throw new ApiError("The cleanup passphrase is incorrect", 401);
  }
  const stores = [STORE_NAME, ...LEGACY_STORE_NAMES].map((name) =>
    getStore({ name, consistency: "strong" }));
  const counts = await Promise.all(stores.map(deleteEveryKey));
  return { deleted: counts.reduce((total, count) => total + count, 0) };
}

async function draw(store, payload) {
  const event = await requireAdmin(store, payload);
  if (event.status === "drawn") throw new ApiError("This event has already been drawn", 409);
  const states = await Promise.all(event.participants.map((person) => getJSON(store, participantKey(event.id, person.id))));
  const includedParticipants = event.participants.filter(isIncluded);
  if (includedParticipants.length < 3) throw new ApiError("At least 3 included people are required");
  if (states.some((state, index) => isIncluded(event.participants[index]) && !state?.claimed)) {
    throw new ApiError("Everyone included must join before the draw");
  }
  const includedIds = new Set(includedParticipants.map((person) => person.id));
  const activeExclusions = event.exclusions.filter(([first, second]) =>
    includedIds.has(first) && includedIds.has(second));
  const assignments = makeAssignments(includedParticipants, activeExclusions);
  if (!assignments) throw new ApiError("The couple rules make a complete draw impossible");

  await Promise.all(includedParticipants.map((person) =>
    store.setJSON(assignmentKey(event.id, person.id), { recipientId: assignments.get(person.id) })));
  event.status = "drawn";
  event.drawnAt = new Date().toISOString();
  await store.setJSON(eventKey(event.id), event);
  return { drawn: true };
}

export default async (request) => {
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const payload = await request.json();
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const handlers = {
      "create-event": createEvent,
      "event-info": eventInfo,
      claim,
      login,
      "participant-view": participantView,
      "update-preferences": updatePreferences,
      "admin-status": adminStatus,
      "set-participation": setParticipation,
      "reset-event": resetEvent,
      "delete-event": deleteEvent,
      "clear-all-events": clearAllEvents,
      draw
    };
    const handler = handlers[payload.action];
    if (!handler) throw new ApiError("Unknown action");
    return response(await handler(store, payload));
  } catch (error) {
    if (error instanceof ApiError) return response({ error: error.message }, error.status);
    console.error("Secret Santa function failed", error);
    return response({ error: "The server could not complete that request" }, 500);
  }
};

export const config = {
  path: "/api/secret-santa",
  method: "POST",
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: "ip",
    action: "rate_limit"
  }
};

export const testing = {
  makeAssignments,
  validateEventInput,
  validatePreferences,
  validatePhoto,
  validatePhotos,
  deleteEveryKey,
  handlers: {
    createEvent,
    eventInfo,
    claim,
    login,
    participantView,
    updatePreferences,
    adminStatus,
    setParticipation,
    resetEvent,
    deleteEvent,
    clearAllEvents,
    draw
  }
};
