const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PRACTICE_MODES, SESSION_DURATION_MS, practiceMode, compatibleModes, sessionDetails, currentQuestion, isParticipant, canUseRoom, validFeedback, feedbackWithCriteria, finishFeedback } = require('./session-rules');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qjghjsapizkqktcbczgj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_LPppVZWRepW4yHykfUS2EQ_sH9dwksM';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DAILY_API_KEY = process.env.DAILY_API_KEY || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const JOIN_EARLY_MS = 10 * 60 * 1000;
const JOIN_GRACE_MS = 15 * 60 * 1000;
const SCHEDULE_BLOCK_MS = SESSION_DURATION_MS + JOIN_GRACE_MS;
const MAX_OPEN_LISTINGS = 4;
const MAX_UPCOMING_MATCHES = 4;
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 25_000
});

const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'mocksyra.json');
fs.mkdirSync(dataDir, { recursive: true });

let db = { profiles: {}, listings: {}, matches: {}, notifications: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch {}

let remoteSaveTimer;

function migrateLegacyState() {
  let changed = false;
  if (!db.listings || typeof db.listings !== 'object' || Array.isArray(db.listings)) { db.listings = {}; changed = true; }
  Object.values(db.profiles || {}).forEach(profile => {
    if (!profile || typeof profile !== 'object' || !profile.email) return;
    if (!PRACTICE_MODES.includes(profile.practiceMode)) { profile.practiceMode = 'candidate'; changed = true; }
    if (profile.status === 'waiting') {
      const futureSlots = slotsFor(profile).filter(slot => Date.parse(slot) > Date.now()).slice(0, MAX_OPEN_LISTINGS);
      futureSlots.forEach((slot, index) => {
        const normalizedSlot = new Date(slot).toISOString();
        const alreadyMigrated = Object.values(db.listings).some(listing => listing.email === profile.email && slotsFor(listing).some(existing => new Date(existing).toISOString() === normalizedSlot));
        if (alreadyMigrated) return;
        const legacyListingId = cleanText(profile.listingId, 100);
        const listingId = index === 0 && legacyListingId && !db.listings[legacyListingId] ? legacyListingId : `listing-${randomUUID()}`;
        db.listings[listingId] = { ...profile, listingId, slots: [normalizedSlot], status: 'waiting', createdAt: profile.updatedAt || new Date().toISOString() };
      });
      profile.status = 'idle';
      changed = true;
    } else if (profile.status !== 'idle') {
      profile.status = 'idle';
      changed = true;
    }
    if (Object.hasOwn(profile, 'listingId')) { delete profile.listingId; changed = true; }
  });
  Object.values(db.matches || {}).forEach(match => {
    const legacyRoles = match.people?.some(person => !PRACTICE_MODES.includes(person.practiceMode));
    if (!legacyRoles || !['matched', 'in_progress', 'feedback_pending'].includes(match.status)) return;
    match.status = 'expired'; match.expiredAt = new Date().toISOString(); changed = true;
  });
  return changed;
}

function save() {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  if (!SUPABASE_SECRET_KEY) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(saveRemoteState, 1200);
}

async function saveRemoteState() {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
      method: 'POST',
      headers: {
        ...supabaseAdminHeaders(),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ id: 'primary', payload: db, updated_at: new Date().toISOString() })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) { console.error('Supabase persistence failed:', error.message); }
}

async function loadRemoteState() {
  if (!SUPABASE_SECRET_KEY) return;
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.primary&select=payload`, {
      headers: supabaseAdminHeaders()
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    if (rows[0]?.payload) db = { profiles: {}, listings: {}, matches: {}, notifications: [], ...rows[0].payload };
  } catch (error) { console.error('Using local persistence:', error.message); }
}

function supabaseAdminHeaders() {
  const headers = { apikey: SUPABASE_SECRET_KEY };
  if (SUPABASE_SECRET_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  return headers;
}

const questionBank = {
  'Data Structures & Algorithms': [
    { title: 'Pair with target sum', prompt: 'Given an array of integers and a target, return the indices of two values whose sum equals the target. Discuss complexity and duplicate values.', hints: ['Start with a brute-force baseline.', 'Ask whether a hash map can trade space for time.'], starter: `function pairWithTarget(numbers, target) {\n  // Explain your approach before coding.\n}\n\nconsole.log(pairWithTarget([2, 7, 11, 15], 9));` },
    { title: 'Balanced brackets', prompt: 'Determine whether brackets in a string are correctly balanced. Extend the solution to ignore non-bracket characters.', hints: ['Which data structure remembers the most recent opener?', 'Discuss empty input and early exits.'], starter: `function isBalanced(input) {\n  // Your solution\n}\n\nconsole.log(isBalanced('{[()]}'));` }
  ],
  Frontend: [
    { title: 'Search with debounce', prompt: 'Design an accessible search component that debounces requests, handles loading and error states, and prevents stale responses from replacing new results.', hints: ['Ask about AbortController.', 'Discuss keyboard and screen-reader behavior.'], starter: `function debounce(callback, delay) {\n  // Your implementation\n}` },
    { title: 'Reusable modal', prompt: 'Design a reusable modal component. Cover focus trapping, Escape handling, portals, scroll locking, and cleanup.', hints: ['Ask where focus returns after closing.', 'Discuss nested overlays and mobile behavior.'], starter: `// Sketch the component API and core behavior here.` }
  ],
  Backend: [
    { title: 'Rate-limited API', prompt: 'Design an API rate limiter for authenticated and anonymous clients. Explain storage, distributed consistency, failure modes, and response headers.', hints: ['Compare token bucket and sliding window.', 'Ask how multiple server instances coordinate.'], starter: `// Write pseudocode or an implementation for the limiter.` },
    { title: 'Idempotent payment endpoint', prompt: 'Design an idempotent POST endpoint that safely handles retries, concurrent requests, and partial downstream failures.', hints: ['Ask where idempotency keys are stored.', 'Discuss transaction boundaries.'], starter: `// Define the request flow and data model.` }
  ],
  'System Design': [
    { title: 'Design a notification service', prompt: 'Design a service that delivers email, push, and in-app notifications with preferences, retries, deduplication, and delivery tracking.', hints: ['Clarify scale and delivery guarantees.', 'Discuss queues, workers, and dead-letter handling.'], starter: `// Capture APIs, components, data model, and trade-offs.` },
    { title: 'Design a URL shortener', prompt: 'Design a highly available URL-shortening service with custom aliases, expiration, analytics, and abuse prevention.', hints: ['Estimate read/write traffic.', 'Discuss identifier generation and caching.'], starter: `// Capture requirements, APIs, storage, and scaling.` }
  ],
  Behavioral: [
    { title: 'Disagreement and influence', prompt: 'Tell me about a technical decision where you disagreed with a teammate. How did you reach a decision and what did you learn?', hints: ['Listen for a clear Situation, Task, Action, Result structure.', 'Probe for the candidate’s personal contribution.'], starter: `Situation:\n\nTask:\n\nAction:\n\nResult:\n\nFollow-up:` },
    { title: 'Learning from failure', prompt: 'Describe a project that did not go as planned. What signals did you miss, and what did you change afterward?', hints: ['Ask for measurable consequences.', 'Look for ownership without blame.'], starter: `Situation:\n\nDecision:\n\nOutcome:\n\nLearning:` }
  ],
  SQL: [
    { title: 'Customer retention', prompt: 'Given users and orders tables, return monthly cohorts with the percentage of users who placed another order in the following month.', hints: ['Clarify cohort definition and date boundaries.', 'Discuss window functions or self joins.'], starter: `-- users(id, created_at)\n-- orders(id, user_id, created_at)\n\nSELECT` },
    { title: 'Top products by category', prompt: 'Return the three highest-revenue products in each category, including ties, from products and order_items tables.', hints: ['Ask which ranking function preserves ties.', 'Discuss null prices and cancelled orders.'], starter: `-- products(id, category)\n-- order_items(product_id, quantity, unit_price, status)\n\nSELECT` }
  ]
};

const levels = ['Beginner', 'Intermediate', 'Advanced'];
const online = new Map();
const sessionTimers = new Map();
const dailyRoomPromises = new Map();

function addOnline(email, socketId) {
  if (!online.has(email)) online.set(email, new Set());
  online.get(email).add(socketId);
}
function removeOnline(email, socketId) {
  const sockets = online.get(email);
  if (!sockets) return;
  sockets.delete(socketId);
  if (!sockets.size) online.delete(email);
}
function emitToEmail(email, event, payload) {
  for (const socketId of online.get(email) || []) io.to(socketId).emit(event, payload);
}
function cleanText(value, maximum) { return String(value || '').trim().slice(0, maximum); }
function cleanList(value, allowed, maximum = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => cleanText(item, 50)).filter(item => !allowed || allowed.includes(item)))].slice(0, maximum);
}
function slotsFor(profile) { return cleanList(profile.slots?.length ? profile.slots : [profile.slot], null, MAX_OPEN_LISTINGS).filter(slot => !Number.isNaN(new Date(slot).getTime())); }
function sharedSlots(a, b) { const other = new Set(slotsFor(b)); return slotsFor(a).filter(slot => other.has(slot)).sort(); }
function sharedSkills(a, b) { const other = new Set(b.languages || []); return (a.languages || []).filter(skill => other.has(skill)); }
function actionableMatchesFor(email) {
  expireStaleMatches();
  return Object.values(db.matches)
    .filter(match => ['matched', 'in_progress', 'feedback_pending'].includes(match.status) && match.people.some(person => person.email === email))
    .sort((first, second) => Date.parse(first.sharedSlot) - Date.parse(second.sharedSlot));
}
function upcomingMatchesFor(email) {
  return actionableMatchesFor(email).filter(match => ['matched', 'in_progress'].includes(match.status));
}
function intervalsOverlap(firstSlot, secondSlot, duration = SCHEDULE_BLOCK_MS) {
  const first = Date.parse(firstSlot), second = Date.parse(secondSlot);
  return Number.isFinite(first) && Number.isFinite(second) && first < second + duration && second < first + duration;
}
function hasTimeConflict(email, slot) {
  return upcomingMatchesFor(email).some(match => intervalsOverlap(match.sharedSlot, slot));
}
function inProgressMatchFor(email, exceptRoomId) {
  return Object.values(db.matches).find(match => match.id !== exceptRoomId && match.status === 'in_progress' && match.people.some(person => person.email === email));
}
function hasBookingCapacity(email) {
  return upcomingMatchesFor(email).length < MAX_UPCOMING_MATCHES;
}
function ownOpenListings(email) {
  pruneQueue();
  return Object.values(db.listings)
    .filter(listing => listing.email === email && listing.status === 'waiting')
    .sort((first, second) => Date.parse(slotsFor(first)[0]) - Date.parse(slotsFor(second)[0]));
}
function removeConflictingListings(email, slot) {
  let changed = false;
  Object.entries(db.listings).forEach(([listingId, listing]) => {
    if (listing.email === email && listing.status === 'waiting' && intervalsOverlap(slotsFor(listing)[0], slot)) {
      delete db.listings[listingId];
      changed = true;
    }
  });
  return changed;
}
function expireStaleMatches(now = Date.now()) {
  let changed = false;
  Object.values(db.matches).forEach(match => {
    if (match.status !== 'matched') return;
    const start = Date.parse(match.sharedSlot);
    if (!Number.isFinite(start) || now <= start + JOIN_GRACE_MS) return;
    match.status = 'expired'; match.expiredAt = new Date(now).toISOString(); changed = true;
  });
  if (changed) { save(); io.emit('listings-updated'); }
}
function pruneQueue() {
  let changed = false;
  Object.entries(db.listings || {}).forEach(([listingId, listing]) => {
    if (listing.status !== 'waiting' || !slotsFor(listing).some(slot => Date.parse(slot) > Date.now())) {
      delete db.listings[listingId];
      changed = true;
    }
  });
  if (changed) save();
}

function waitingProfile(email, input) {
  if (!PRACTICE_MODES.includes(input?.practiceMode)) return { error: 'Choose candidate or interviewer.' };
  const previous = db.profiles[email] || {};
  const profile = {
    email,
    name: cleanText(input?.name, 40),
    languages: cleanList(input?.languages, null, 12),
    slots: cleanList(input?.slots, null, MAX_OPEN_LISTINGS),
    interviewType: questionBank[input?.interviewType] ? input.interviewType : '',
    experience: levels.includes(input?.experience) ? input.experience : 'Beginner',
    spokenLanguage: ['English', 'Hindi', 'English + Hindi'].includes(input?.spokenLanguage) ? input.spokenLanguage : 'English',
    practiceMode: practiceMode(input),
    timezone: cleanText(input?.timezone, 60),
    status: 'idle',
    stats: previous.stats || { sessionsCompleted: 0, ratingTotal: 0, averageRating: 0 },
    updatedAt: new Date().toISOString()
  };
  if (!profile.name || !profile.languages.length || !profile.slots.length || !profile.interviewType) return { error: 'Please complete all matching preferences.' };
  if (profile.slots.some(slot => !Number.isFinite(Date.parse(slot)) || Date.parse(slot) <= Date.now())) return { error: 'Choose an upcoming session time. Your previous time may have passed.' };
  profile.slots = [...new Set(profile.slots.map(slot => new Date(slot).toISOString()))].sort();
  return { profile };
}

function createListing(profile, slot) {
  const listingId = `listing-${randomUUID()}`;
  const listing = {
    ...profile,
    listingId,
    slots: [new Date(slot).toISOString()],
    status: 'waiting',
    createdAt: new Date().toISOString()
  };
  db.listings[listingId] = listing;
  return listing;
}

function validateOfferSlots(email, slots) {
  const normalizedSlots = [...new Set((slots || []).map(slot => new Date(slot).toISOString()))].sort();
  const existing = ownOpenListings(email);
  if (existing.length + normalizedSlots.length > MAX_OPEN_LISTINGS) {
    return { error: `You can publish up to ${MAX_OPEN_LISTINGS} open times. Cancel one before adding another.` };
  }
  for (let index = 0; index < normalizedSlots.length; index += 1) {
    const slot = normalizedSlots[index];
    if (hasTimeConflict(email, slot)) return { error: 'That time overlaps one of your booked interviews.' };
    if (existing.some(listing => intervalsOverlap(slotsFor(listing)[0], slot))) return { error: 'That time overlaps one of your existing offers.' };
    if (normalizedSlots.slice(0, index).some(other => intervalsOverlap(other, slot))) return { error: 'Choose times that do not overlap each other.' };
  }
  return { slots: normalizedSlots };
}

function publicListing(profile) {
  const offeredRole = practiceMode(profile);
  return {
    listingId: profile.listingId,
    name: profile.name,
    languages: [...(profile.languages || [])],
    slots: slotsFor(profile).filter(slot => Date.parse(slot) > Date.now()),
    interviewType: profile.interviewType,
    experience: profile.experience,
    spokenLanguage: profile.spokenLanguage,
    practiceMode: offeredRole,
    requiredRole: offeredRole === 'candidate' ? 'interviewer' : 'candidate',
    timezone: profile.timezone,
    sessionsCompleted: Number(profile.stats?.sessionsCompleted) || 0,
    createdAt: profile.createdAt || profile.updatedAt
  };
}

function ownListingsFor(email) {
  return ownOpenListings(email).map(publicListing);
}

function listingsFor(email) {
  pruneQueue();
  return Object.values(db.listings)
    .filter(profile => profile.email !== email && profile.status === 'waiting' && PRACTICE_MODES.includes(practiceMode(profile)) && hasBookingCapacity(profile.email))
    .map(publicListing)
    .filter(listing => listing.slots.length)
    .sort((first, second) => Date.parse(first.slots[0]) - Date.parse(second.slots[0]));
}

function createMatch(first, second, options = {}) {
  const roomId = `room-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const interviewType = options.interviewType || first.interviewType;
  const sharedLanguages = sharedSkills(first, second);
  const match = {
    id: roomId,
    people: [{ ...first }, { ...second }],
    score: options.score === null ? null : (Number(options.score) || 100),
    reasons: options.reasons || ['Session selected by you', `${interviewType} focus`, 'A time that works for you'],
    sharedSlot: options.sharedSlot,
    interviewType,
    bookingType: options.bookingType || 'automatic',
    source: options.bookingType || 'automatic',
    listingId: options.listingId || null,
    scheduledStart: options.sharedSlot,
    mediaProvider: DAILY_API_KEY ? 'daily' : 'webrtc',
    sessionMode: 'directed',
    durationMinutes: 45,
    status: 'matched',
    createdAt: new Date().toISOString(),
    questions: { [first.email]: questionFor(interviewType, 0), [second.email]: questionFor(interviewType, 1) },
    workspace: { code: '', language: sharedLanguages[0] || second.languages?.[0] || first.languages?.[0] || 'JavaScript', version: 0 },
    chat: [],
    feedback: {}
  };
  db.matches[roomId] = match;
  return match;
}

function announceMatch(match) {
  match.people.forEach(person => {
    const peer = match.people.find(other => other.email !== person.email);
    notify(person, 'Your Mocksyra session is booked', `Your 45-minute ${match.interviewType} session with ${peer.name} is confirmed.`, match.id);
    emitToEmail(person.email, 'match-found', publicMatch(match, person.email));
  });
  io.emit('listings-updated');
}

function joinWindow(match, now = Date.now()) {
  const start = Date.parse(match?.sharedSlot);
  const duration = (Number(match?.durationMinutes) || 45) * 60 * 1000;
  if (!Number.isFinite(start)) return { canJoinNow: false, opensAt: null, closesAt: null };
  const opensAt = start - JOIN_EARLY_MS;
  const sessionStart = Date.parse(match?.sessionStartedAt);
  const closesAt = match?.status === 'in_progress' && Number.isFinite(sessionStart) ? sessionStart + duration : start + JOIN_GRACE_MS;
  return { canJoinNow: now >= opensAt && now <= closesAt, opensAt: new Date(opensAt).toISOString(), closesAt: new Date(closesAt).toISOString() };
}

function compatibility(a, b) {
  if (!compatibleModes(a, b)) return null;
  const commonTimes = sharedSlots(a, b), commonSkills = sharedSkills(a, b);
  const languageCompatible = a.spokenLanguage === b.spokenLanguage || [a.spokenLanguage, b.spokenLanguage].includes('English + Hindi');
  if (!commonTimes.length || !commonSkills.length || a.interviewType !== b.interviewType || !languageCompatible) return null;
  const levelDistance = Math.abs(levels.indexOf(a.experience) - levels.indexOf(b.experience));
  const levelPoints = levelDistance === 0 ? 10 : levelDistance === 1 ? 5 : 0;
  const languagePoints = 10;
  const skillPoints = Math.min(30, commonSkills.length * 10);
  return {
    value: Math.min(100, 25 + 25 + skillPoints + levelPoints + languagePoints),
    sharedSlot: commonTimes[0],
    commonSkills,
    reasons: [`Same ${a.interviewType} practice`, `${commonSkills.join(', ')} in common`, levelPoints === 10 ? 'Same experience level' : 'Compatible experience levels', languagePoints ? 'Compatible conversation language' : 'Shared technical focus']
  };
}

function bestMatch(profile) {
  pruneQueue();
  let best;
  for (const candidate of Object.values(db.listings)) {
    if (candidate.email === profile.email || candidate.status !== 'waiting') continue;
    const result = compatibility(profile, candidate);
    if (!result || !hasBookingCapacity(candidate.email) || hasTimeConflict(profile.email, result.sharedSlot) || hasTimeConflict(candidate.email, result.sharedSlot)) continue;
    if (!best || result.value > best.result.value) best = { candidate, result };
  }
  return best;
}

function questionFor(type, offset) {
  const questions = questionBank[type] || questionBank['Data Structures & Algorithms'];
  return questions[offset % questions.length];
}

function publicPeer(profile) {
  return { name: profile.name, languages: profile.languages, experience: profile.experience, spokenLanguage: profile.spokenLanguage, practiceMode: practiceMode(profile), sessionsCompleted: profile.stats?.sessionsCompleted || 0 };
}
function publicMatch(match, email, now = Date.now()) {
  const peer = match.people.find(person => person.email !== email);
  return {
    roomId: match.id,
    peer: publicPeer(peer),
    score: match.score,
    reasons: match.reasons,
    sharedSlot: match.sharedSlot,
    interviewType: match.interviewType,
    ...sessionDetails(match, email, now),
    question: currentQuestion(match, email, now, questionFor(match.interviewType, 0)),
    bookingType: match.bookingType || 'automatic',
    source: match.source || match.bookingType || 'automatic',
    listingId: match.listingId || null,
    scheduledStart: match.scheduledStart || match.sharedSlot,
    videoProvider: match.mediaProvider || 'webrtc',
    ...joinWindow(match, now),
    status: match.status,
    selfFeedback: feedbackWithCriteria(match, email),
    feedbackSubmitted: Boolean(match.feedback?.[email])
  };
}
function historyFor(email, matches = db.matches) {
  return Object.values(matches).filter(match => match.status === 'completed' && match.people.some(person => person.email === email)).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 25).map(match => {
    const peer = match.people.find(person => person.email !== email);
    const details = sessionDetails(match, email);
    return { roomId: match.id, peer: publicPeer(peer), interviewType: match.interviewType, sharedSlot: match.sharedSlot, completedAt: match.completedAt, practiceMode: details.practiceMode, sessionMode: details.sessionMode, durationMinutes: details.durationMinutes, peerRole: details.peerRole, feedbackCriteria: details.receivedFeedbackCriteria, feedbackReceived: feedbackWithCriteria(match, peer.email) };
  });
}

function profileStateFor(email) {
  const profile = db.profiles[email];
  const activeMatches = actionableMatchesFor(email).map(match => publicMatch(match, email));
  const upcomingMatches = upcomingMatchesFor(email).map(match => publicMatch(match, email));
  const ownListings = ownListingsFor(email);
  const profilePayload = profile ? { ...profile, practiceMode: practiceMode(profile) } : null;
  if (profilePayload && ownListings.length) {
    profilePayload.status = 'waiting';
    profilePayload.listingId = ownListings[0].listingId;
  }
  return {
    profile: profilePayload,
    activeMatch: activeMatches[0] || null,
    activeMatches,
    upcomingMatches,
    ownListings,
    history: historyFor(email),
    notifications: db.notifications.filter(item => item.email === email).slice(-20).reverse()
  };
}

function scheduleStateFor(email) {
  const activeMatches = actionableMatchesFor(email).map(match => publicMatch(match, email));
  return {
    activeMatch: activeMatches[0] || null,
    activeMatches,
    upcomingMatches: upcomingMatchesFor(email).map(match => publicMatch(match, email)),
    ownListings: ownListingsFor(email)
  };
}

function emitScheduleState(email) {
  emitToEmail(email, 'schedule-updated', scheduleStateFor(email));
}

function clearSessionTimers(roomId) {
  for (const timer of sessionTimers.get(roomId) || []) clearTimeout(timer);
  sessionTimers.delete(roomId);
}

function emitSessionState(match, event) {
  match.people.forEach(person => emitToEmail(person.email, event, { roomId: match.id, ...sessionDetails(match, person.email), question: currentQuestion(match, person.email, Date.now(), questionFor(match.interviewType, 0)) }));
}

function finishSession(match) {
  if (match.status !== 'in_progress') return false;
  match.status = 'feedback_pending';
  match.sessionEndedAt = new Date().toISOString();
  clearSessionTimers(match.id);
  save();
  match.people.forEach(person => {
    emitToEmail(person.email, 'session-ended', { roomId: match.id });
    emitScheduleState(person.email);
  });
  io.in(match.id).socketsLeave(match.id);
  return true;
}

function scheduleSessionTimers(match) {
  clearSessionTimers(match.id);
  if (match.status !== 'in_progress' || !match.sessionStartedAt) return;
  const started = Date.parse(match.sessionStartedAt);
  if (!Number.isFinite(started)) return;
  const duration = SESSION_DURATION_MS;
  const remaining = started + duration - Date.now();
  if (remaining <= 0) { finishSession(match); return; }
  const timers = [];
  timers.push(setTimeout(() => finishSession(match), remaining));
  timers.forEach(timer => timer.unref());
  sessionTimers.set(match.id, timers);
}

function acknowledge(callback, packet) { if (typeof callback === 'function') callback(packet); }
function reject(socket, callback, error, details = {}) {
  acknowledge(callback, { ok: false, error, ...details });
  if (typeof callback !== 'function') socket.emit('app-error', error);
}

async function sendEmail(profile, title, body) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [profile.email], subject: title, text: `${body}\n\nOpen Mocksyra: ${APP_URL}` })
    });
    if (!response.ok) console.error('Email delivery failed:', response.status);
  } catch (error) { console.error('Email delivery failed:', error.message); }
}

async function dailyRequest(pathname, body) {
  const response = await fetch(`https://api.daily.co/v1/${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DAILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.info || payload.error || `Daily API returned HTTP ${response.status}`);
  return payload;
}

async function ensureDailyRoom(match) {
  if (!DAILY_API_KEY || match.mediaProvider !== 'daily') return null;
  if (match.dailyRoom?.url) return match.dailyRoom;
  if (dailyRoomPromises.has(match.id)) return dailyRoomPromises.get(match.id);
  const promise = (async () => {
    const exp = Math.floor((Date.parse(match.sharedSlot) + SESSION_DURATION_MS + JOIN_GRACE_MS) / 1000);
    const nbf = Math.floor((Date.parse(match.sharedSlot) - JOIN_EARLY_MS) / 1000);
    const room = await dailyRequest('rooms', {
      name: match.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120),
      privacy: 'private',
      properties: { nbf, exp, eject_at_room_exp: true, enforce_unique_user_ids: true, enable_prejoin_ui: true, enable_screenshare: true, enable_network_ui: true, enable_chat: false, max_participants: 2 }
    });
    match.dailyRoom = { name: room.name, url: room.url, exp };
    save();
    return match.dailyRoom;
  })().finally(() => dailyRoomPromises.delete(match.id));
  dailyRoomPromises.set(match.id, promise);
  return promise;
}

async function dailyAccessFor(match, person, userId) {
  const room = await ensureDailyRoom(match);
  if (!room) return { provider: 'webrtc' };
  const token = await dailyRequest('meeting-tokens', {
    properties: {
      room_name: room.name,
      user_name: person.name,
      user_id: userId,
      nbf: Math.floor((Date.parse(match.sharedSlot) - JOIN_EARLY_MS) / 1000),
      exp: room.exp,
      is_owner: false,
      eject_at_token_exp: true,
      enable_prejoin_ui: true
    }
  });
  return { provider: 'daily', roomUrl: room.url, token: token.token, expiresAt: new Date(room.exp * 1000).toISOString() };
}

function notify(profile, title, body, matchId) {
  const item = { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, email: profile.email, title, body, matchId, createdAt: new Date().toISOString(), read: false };
  db.notifications.push(item);
  if (db.notifications.length > 1000) db.notifications = db.notifications.slice(-1000);
  save();
  emitToEmail(profile.email, 'notification', item);
  fs.appendFileSync(path.join(dataDir, 'notification-outbox.jsonl'), `${JSON.stringify(item)}\n`);
  sendEmail(profile, title, body);
}

function authorizedMatch(socket, roomId) {
  const match = db.matches[cleanText(roomId, 100)];
  return isParticipant(match, socket.data.email) ? match : null;
}
function roomParticipantEmails(roomId) {
  const members = io.sockets.adapter.rooms.get(roomId) || new Set();
  return new Set([...members].map(id => io.sockets.sockets.get(id)?.data.email).filter(Boolean));
}
function validRoomPacket(socket, packet) {
  const roomId = cleanText(packet?.roomId, 100);
  const match = authorizedMatch(socket, roomId);
  return canUseRoom(match, socket.data.email, socket.rooms.has(roomId)) ? { match, roomId } : null;
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.accessToken;
  if (!token) return next(new Error('Authentication required'));
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` } });
    if (!response.ok) return next(new Error('Authentication required'));
    const user = await response.json();
    if (!user.email) return next(new Error('Authentication required'));
    socket.data.email = user.email.toLowerCase();
    socket.data.userId = user.id;
    socket.data.displayName = cleanText(user.user_metadata?.full_name || user.user_metadata?.name, 40);
    next();
  } catch { next(new Error('Authentication required')); }
});

io.on('connection', socket => {
  const email = socket.data.email;
  addOnline(email, socket.id);

  socket.on('restore-profile', () => {
    const state = profileStateFor(email);
    socket.emit('profile-state', state);
    if (state.activeMatch) socket.emit('match-found', state.activeMatch);
    socket.emit('session-listings', listingsFor(email));
    socket.emit('notifications', state.notifications);
    socket.emit('history', state.history);
  });

  socket.on('publish-listing', (input, callback) => {
    if (!hasBookingCapacity(email)) return reject(socket, callback, `You can have up to ${MAX_UPCOMING_MATCHES} upcoming interviews. Cancel or complete one before offering another time.`);
    const result = waitingProfile(email, input);
    if (result.error) return reject(socket, callback, result.error);
    const validation = validateOfferSlots(email, result.profile.slots);
    if (validation.error) return reject(socket, callback, validation.error);
    db.profiles[email] = result.profile;
    const listingsCreated = validation.slots.map(slot => createListing(result.profile, slot));
    save();
    const schedule = scheduleStateFor(email);
    acknowledge(callback, {
      ok: true,
      profile: { ...result.profile, status: 'waiting', listingId: listingsCreated[0].listingId },
      listing: publicListing(listingsCreated[0]),
      listingsCreated: listingsCreated.map(publicListing),
      ...schedule,
      listings: listingsFor(email),
      serverNow: new Date().toISOString()
    });
    socket.emit('session-listings', listingsFor(email));
    emitScheduleState(email);
    io.emit('listings-updated');
  });

  socket.on('browse-listings', (_, callback) => {
    acknowledge(callback, { ok: true, listings: listingsFor(email), ...scheduleStateFor(email), serverNow: new Date().toISOString() });
  });

  socket.on('book-listing', (packet, callback) => {
    if (!hasBookingCapacity(email)) return reject(socket, callback, `You can have up to ${MAX_UPCOMING_MATCHES} upcoming interviews.`);
    pruneQueue();
    const listingId = cleanText(packet?.listingId, 100);
    const target = db.listings[listingId];
    if (target?.email === email) return reject(socket, callback, 'You cannot book your own offer.');
    if (!target || target.status !== 'waiting') return reject(socket, callback, 'That session was just booked or is no longer available. Refresh to see current sessions.');
    if (!hasBookingCapacity(target.email)) return reject(socket, callback, 'That person already has four upcoming interviews. Choose another open time.');
    const requestedSlot = cleanText(packet?.slot, 60);
    const targetSlot = slotsFor(target)[0];
    const slotTime = Date.parse(requestedSlot);
    if (!targetSlot || !Number.isFinite(slotTime) || slotTime !== Date.parse(targetSlot) || slotTime <= Date.now()) return reject(socket, callback, 'That time is no longer available.');
    const slot = new Date(slotTime).toISOString();
    if (hasTimeConflict(email, slot)) return reject(socket, callback, 'That time overlaps one of your booked interviews.');
    if (hasTimeConflict(target.email, slot)) return reject(socket, callback, 'That person is no longer available at this time. Choose another session.');
    const previous = db.profiles[email] || {};
    const bookingProfile = packet?.profile || {};
    const requiredRole = practiceMode(target) === 'candidate' ? 'interviewer' : 'candidate';
    const prepared = waitingProfile(email, {
      name: bookingProfile.name || previous.name || socket.data.displayName || email.split('@')[0].replace(/[._-]+/g, ' '),
      languages: bookingProfile.languages?.length ? bookingProfile.languages : previous.languages?.length ? previous.languages : target.languages,
      slots: [slot],
      interviewType: target.interviewType,
      experience: bookingProfile.experience || previous.experience || 'Beginner',
      spokenLanguage: bookingProfile.spokenLanguage || previous.spokenLanguage || target.spokenLanguage || 'English',
      practiceMode: requiredRole,
      timezone: bookingProfile.timezone || previous.timezone || target.timezone || 'UTC'
    });
    if (prepared.error) return reject(socket, callback, prepared.error);
    const profile = prepared.profile;
    db.profiles[email] = profile;
    const match = createMatch(profile, target, {
      sharedSlot: slot,
      interviewType: target.interviewType,
      bookingType: 'marketplace',
      listingId,
      score: null,
      reasons: ['Session selected by you', `${target.interviewType} focus`, `${target.languages.join(', ')} practice`]
    });
    delete db.listings[listingId];
    removeConflictingListings(email, slot);
    removeConflictingListings(target.email, slot);
    save();
    acknowledge(callback, { ok: true, profile: { ...profile }, ...scheduleStateFor(email) });
    announceMatch(match);
    match.people.forEach(person => emitScheduleState(person.email));
  });

  socket.on('find-match', (input, callback) => {
    if (!hasBookingCapacity(email)) return reject(socket, callback, `You can have up to ${MAX_UPCOMING_MATCHES} upcoming interviews.`);
    const previous = db.profiles[email];
    const prepared = input?.name ? waitingProfile(email, input) : previous ? waitingProfile(email, { ...previous, slots: slotsFor(previous) }) : {};
    if (!prepared.profile || prepared.error) return reject(socket, callback, prepared.error || 'Publish your availability before asking for an automatic match.');
    const profile = prepared.profile;
    db.profiles[email] = profile;
    const found = bestMatch(profile);
    if (!found) {
      const existingSlotTimes = new Set(ownOpenListings(email).map(listing => Date.parse(slotsFor(listing)[0])));
      const newSlots = profile.slots.filter(slot => !existingSlotTimes.has(Date.parse(slot)));
      if (!newSlots.length) {
        const schedule = scheduleStateFor(email);
        acknowledge(callback, { ok: true, waiting: true, profile, listingsCreated: [], ...schedule });
        socket.emit('match-waiting');
        return;
      }
      const validation = validateOfferSlots(email, newSlots);
      if (validation.error) return reject(socket, callback, validation.error);
      const listingsCreated = validation.slots.map(slot => createListing(profile, slot));
      save();
      const schedule = scheduleStateFor(email);
      acknowledge(callback, { ok: true, waiting: true, profile, listing: publicListing(listingsCreated[0]), listingsCreated: listingsCreated.map(publicListing), ...schedule });
      socket.emit('match-waiting');
      emitScheduleState(email);
      return io.emit('listings-updated');
    }
    const slot = new Date(found.result.sharedSlot).toISOString();
    const match = createMatch(profile, found.candidate, { sharedSlot: slot, score: found.result.value, reasons: found.result.reasons, listingId: found.candidate.listingId });
    delete db.listings[found.candidate.listingId];
    removeConflictingListings(email, slot);
    removeConflictingListings(found.candidate.email, slot);
    save();
    acknowledge(callback, { ok: true, profile: { ...profile }, ...scheduleStateFor(email) });
    announceMatch(match);
    match.people.forEach(person => emitScheduleState(person.email));
  });

  socket.on('cancel-search', (packet, callback) => {
    if (typeof packet === 'function') { callback = packet; }
    let changed = false;
    Object.entries(db.listings).forEach(([listingId, listing]) => {
      if (listing.email !== email) return;
      delete db.listings[listingId];
      changed = true;
    });
    if (changed) save();
    const schedule = scheduleStateFor(email);
    acknowledge(callback, { ok: true, ...schedule, listings: listingsFor(email) });
    if (changed) { emitScheduleState(email); io.emit('listings-updated'); }
  });

  socket.on('cancel-listing', (listingIdValue, callback) => {
    pruneQueue();
    const listingId = cleanText(typeof listingIdValue === 'object' ? listingIdValue?.listingId : listingIdValue, 100);
    const listing = db.listings[listingId];
    if (!listing || listing.email !== email) return reject(socket, callback, 'That offer is no longer available.');
    delete db.listings[listingId];
    save();
    const schedule = scheduleStateFor(email);
    acknowledge(callback, { ok: true, cancelledListingId: listingId, ...schedule, listings: listingsFor(email) });
    emitScheduleState(email);
    io.emit('listings-updated');
  });

  socket.on('cancel-match', (roomIdValue, callback) => {
    const roomId = cleanText(typeof roomIdValue === 'object' ? roomIdValue?.roomId : roomIdValue, 100);
    const match = authorizedMatch(socket, roomId);
    if (!canUseRoom(match, email, false, 'cancel')) return reject(socket, callback, 'Only a match that has not started can be cancelled.');
    match.status = 'cancelled';
    match.cancelledAt = new Date().toISOString();
    clearSessionTimers(roomId);
    save();
    match.people.forEach(person => {
      emitToEmail(person.email, 'match-cancelled', { roomId, message: 'This interview was cancelled. You can book another open session.' });
      emitScheduleState(person.email);
    });
    io.emit('listings-updated');
    io.in(roomId).socketsLeave(roomId);
    acknowledge(callback, { ok: true, cancelledRoomId: roomId, ...scheduleStateFor(email) });
  });

  socket.on('prepare-call', async (packet, callback) => {
    const roomId = cleanText(typeof packet === 'object' ? packet?.roomId : packet, 100);
    const match = authorizedMatch(socket, roomId);
    if (!match || !['matched', 'in_progress'].includes(match.status)) return reject(socket, callback, 'This interview room is unavailable.');
    const busyParticipant = match.people.find(person => inProgressMatchFor(person.email, roomId));
    if (busyParticipant) return reject(socket, callback, busyParticipant.email === email ? 'Finish your current live interview before joining another room.' : 'Your interview partner is still in another live interview. Please wait and retry.');
    const window = joinWindow(match);
    if (!window.canJoinNow) return reject(socket, callback, `This room opens 10 minutes before the scheduled session.`, { code: 'TOO_EARLY', ...window });
    if (match.mediaProvider !== 'daily') return acknowledge(callback, { ok: true, provider: 'webrtc', ...window });
    if (!DAILY_API_KEY) return reject(socket, callback, 'Hosted video is not configured for this session. Contact support or reschedule.', { code: 'DAILY_NOT_CONFIGURED' });
    try {
      const person = match.people.find(participant => participant.email === email);
      const access = await dailyAccessFor(match, person, socket.data.userId);
      if (!socket.connected) return;
      const currentMatch = authorizedMatch(socket, roomId);
      if (currentMatch !== match || !['matched', 'in_progress'].includes(currentMatch?.status) || currentMatch.mediaProvider !== 'daily') {
        return reject(socket, callback, 'This interview room is no longer available.');
      }
      const currentBusyParticipant = currentMatch.people.find(participant => inProgressMatchFor(participant.email, roomId));
      if (currentBusyParticipant) return reject(socket, callback, currentBusyParticipant.email === email ? 'Finish your current live interview before joining another room.' : 'Your interview partner is still in another live interview. Please wait and retry.');
      const currentWindow = joinWindow(currentMatch);
      if (!currentWindow.canJoinNow) return reject(socket, callback, 'This interview room is no longer open.', { code: 'JOIN_WINDOW_CLOSED', ...currentWindow });
      acknowledge(callback, { ok: true, ...access, ...currentWindow });
    } catch (error) {
      console.error('Daily call preparation failed:', error.message);
      reject(socket, callback, 'The hosted video room is temporarily unavailable. Please retry.', { code: 'VIDEO_SERVICE_UNAVAILABLE' });
    }
  });

  socket.on('join-session', (roomIdValue, callback) => {
    const roomId = cleanText(roomIdValue, 100), match = authorizedMatch(socket, roomId);
    if (!match || !['matched', 'in_progress'].includes(match.status)) return reject(socket, callback, 'This interview room is unavailable.');
    const busyParticipant = match.people.find(person => inProgressMatchFor(person.email, roomId));
    if (busyParticipant) return reject(socket, callback, busyParticipant.email === email ? 'Finish your current live interview before joining another room.' : 'Your interview partner is still in another live interview. Please wait and retry.');
    if (match.status === 'matched' && !joinWindow(match).canJoinNow) return reject(socket, callback, `This room opens 10 minutes before ${new Date(match.sharedSlot).toLocaleString('en', { timeZone: 'UTC' })} UTC.`);
    if (match.status === 'in_progress') scheduleSessionTimers(match);
    if (match.status !== 'matched' && match.status !== 'in_progress') return reject(socket, callback, 'This interview has ended. Please share your feedback.');
    socket.join(roomId);
    const peer = match.people.find(person => person.email !== email);
    emitToEmail(peer.email, 'peer-entered-room', { roomId });
    const participants = roomParticipantEmails(roomId);
    if (participants.size >= 2) {
      if (!match.sessionStartedAt) match.sessionStartedAt = new Date().toISOString();
      match.status = 'in_progress'; save();
      scheduleSessionTimers(match);
      emitSessionState(match, 'session-ready');
    }
    acknowledge(callback, { ok: true, ...sessionDetails(match, email), question: currentQuestion(match, email, Date.now(), questionFor(match.interviewType, 0)) });
  });

  socket.on('leave-session', (roomIdValue, callback) => {
    const roomId = cleanText(typeof roomIdValue === 'object' ? roomIdValue?.roomId : roomIdValue, 100);
    const match = authorizedMatch(socket, roomId);
    if (!match) return reject(socket, callback, 'This interview room is unavailable.');
    const wasJoined = socket.rooms.has(roomId);
    socket.leave(roomId);
    if (wasJoined && !roomParticipantEmails(roomId).has(email)) socket.to(roomId).emit('peer-left', { roomId });
    acknowledge(callback, { ok: true });
  });

  socket.on('signal', packet => {
    const valid = validRoomPacket(socket, packet);
    if (!valid || !packet.data || typeof packet.data !== 'object') return;
    socket.to(valid.roomId).emit('signal', { ...packet.data, roomId: valid.roomId });
  });

  socket.on('workspace-request', roomIdValue => {
    const roomId = cleanText(roomIdValue, 100), match = authorizedMatch(socket, roomId);
    if (!canUseRoom(match, email, socket.rooms.has(roomId))) return;
    socket.emit('workspace-state', { roomId, ...(match.workspace || { code: '', language: 'JavaScript', version: 0 }) });
    socket.emit('chat-state', { roomId, messages: match.chat || [] });
  });

  socket.on('workspace-update', packet => {
    const valid = validRoomPacket(socket, packet); if (!valid) return;
    const workspace = valid.match.workspace || { version: 0 };
    valid.match.workspace = { code: String(packet.code || '').slice(0, 20_000), language: cleanText(packet.language, 30) || 'Plain text', version: Number(workspace.version || 0) + 1, updatedBy: email };
    save(); io.to(valid.roomId).emit('workspace-update', { roomId: valid.roomId, ...valid.match.workspace });
  });

  socket.on('chat-message', packet => {
    const valid = validRoomPacket(socket, packet); if (!valid) return;
    const message = cleanText(packet.message, 500); if (!message) return;
    const profile = valid.match.people.find(person => person.email === email);
    const item = { id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: profile.name, message, createdAt: new Date().toISOString() };
    valid.match.chat = [...(valid.match.chat || []), item].slice(-50); save(); io.to(valid.roomId).emit('chat-message', { roomId: valid.roomId, ...item });
  });

  socket.on('complete-session', (roomIdValue, callback) => {
    const roomId = cleanText(roomIdValue, 100), match = authorizedMatch(socket, roomId);
    if (isParticipant(match, email) && ['feedback_pending', 'completed'].includes(match.status)) return acknowledge(callback, { ok: true, ended: true });
    if (!canUseRoom(match, email, socket.rooms.has(roomId), 'finish')) return reject(socket, callback, 'Both participants must join before finishing an interview.');
    finishSession(match);
    acknowledge(callback, { ok: true, ended: true });
  });

  socket.on('submit-feedback', (packet, callback) => {
    const match = authorizedMatch(socket, packet?.roomId);
    if (match && ['completed', 'feedback_pending'].includes(match.status) && match.feedback?.[email]) {
      return acknowledge(callback, { ok: true, submitted: true, completed: match.status === 'completed', selfFeedback: feedbackWithCriteria(match, email) });
    }
    if (!canUseRoom(match, email, false, 'feedback')) return reject(socket, callback, 'Feedback opens after this interview ends.');
    const feedback = validFeedback(packet.feedback, sessionDetails(match, email).feedbackCriteria);
    if (!feedback) return reject(socket, callback, 'Choose three ratings from 1 to 5, write at least five characters in each feedback field, and choose whether to practise again.');
    match.feedback = match.feedback || {};
    match.feedback[email] = feedback; save();
    const peer = match.people.find(person => person.email !== email);
    emitToEmail(peer.email, 'peer-feedback-submitted', { roomId: match.id });
    const completed = finishFeedback(match, db.profiles);
    acknowledge(callback, { ok: true, submitted: true, completed, selfFeedback: feedback });
    if (!completed) return;
    save();
    match.people.forEach(person => {
      const other = match.people.find(candidate => candidate.email !== person.email);
      emitToEmail(person.email, 'feedback-ready', { roomId: match.id, ...feedbackWithCriteria(match, other.email) });
      emitToEmail(person.email, 'history', historyFor(person.email));
      notify(person, 'Your interview feedback is ready', 'Both feedback forms are in. Open Mocksyra to review and download your feedback.', match.id);
    });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const otherSession = [...(io.sockets.adapter.rooms.get(roomId) || [])].some(id => id !== socket.id && io.sockets.sockets.get(id)?.data.email === email);
      if (!otherSession) socket.to(roomId).emit('peer-left', { roomId });
    }
  });
  socket.on('disconnect', () => removeOnline(email, socket.id));
});

app.get('/health', (_, response) => response.status(200).json({ status: 'ok', persistence: SUPABASE_SECRET_KEY ? 'supabase' : 'local', video: DAILY_API_KEY ? 'daily-ready' : 'webrtc-fallback' }));
const publicAssets = new Set(['index.html', 'styles.css', 'call.css', 'features.css', 'design.css', 'app.js', 'auth.js', 'supabase.js', 'runtime-config.js', 'site-config.js', 'runner.html', 'runner.js']);
app.get('*', (request, response) => {
  const asset = request.path === '/' ? 'index.html' : request.path.slice(1);
  if (!publicAssets.has(asset)) return response.status(404).type('text').send('Not found');
  response.sendFile(path.join(__dirname, asset));
});

const port = process.env.PORT || 3000;
async function start() {
  await loadRemoteState();
  if (migrateLegacyState()) save();
  Object.values(db.matches).forEach(scheduleSessionTimers);
  return server.listen(port, () => console.log(`Mocksyra is running at http://localhost:${port}`));
}

if (require.main === module) start();
module.exports = { app, server, compatibility, sharedSlots, sharedSkills, questionFor, publicMatch, historyFor };
