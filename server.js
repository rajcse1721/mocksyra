const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PRACTICE_MODES, HALF_SESSION_MS, practiceMode, compatibleModes, sessionMode, sessionDetails, currentQuestion, isParticipant, canUseRoom, validFeedback, feedbackWithCriteria, finishFeedback } = require('./session-rules');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qjghjsapizkqktcbczgj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_LPppVZWRepW4yHykfUS2EQ_sH9dwksM';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
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

let db = { profiles: {}, matches: {}, notifications: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch {}

let remoteSaveTimer;
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
    if (rows[0]?.payload) db = { profiles: {}, matches: {}, notifications: [], ...rows[0].payload };
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
function slotsFor(profile) { return cleanList(profile.slots?.length ? profile.slots : [profile.slot], null, 3).filter(slot => !Number.isNaN(new Date(slot).getTime())); }
function sharedSlots(a, b) { const other = new Set(slotsFor(b)); return slotsFor(a).filter(slot => other.has(slot)).sort(); }
function sharedSkills(a, b) { const other = new Set(b.languages || []); return (a.languages || []).filter(skill => other.has(skill)); }
function activeMatchFor(email) {
  return Object.values(db.matches).find(match => ['matched', 'in_progress', 'feedback_pending'].includes(match.status) && match.people.some(person => person.email === email));
}
function pruneQueue() {
  const expiry = Date.now() - 90 * 60 * 1000;
  Object.values(db.profiles).forEach(profile => {
    if (profile.status === 'waiting' && !slotsFor(profile).some(slot => new Date(slot).getTime() > expiry)) profile.status = 'expired';
  });
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
  for (const candidate of Object.values(db.profiles)) {
    if (candidate.email === profile.email || candidate.status !== 'waiting') continue;
    const result = compatibility(profile, candidate);
    if (result && (!best || result.value > best.result.value)) best = { candidate, result };
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
  const active = activeMatchFor(email);
  return {
    profile: profile ? { ...profile, practiceMode: practiceMode(profile) } : null,
    activeMatch: active ? publicMatch(active, email) : null,
    history: historyFor(email),
    notifications: db.notifications.filter(item => item.email === email).slice(-20).reverse()
  };
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
  match.people.forEach(person => emitToEmail(person.email, 'session-ended', { roomId: match.id }));
  return true;
}

function scheduleSessionTimers(match) {
  clearSessionTimers(match.id);
  if (match.status !== 'in_progress' || !match.sessionStartedAt) return;
  const started = Date.parse(match.sessionStartedAt);
  if (!Number.isFinite(started)) return;
  const duration = sessionMode(match) === 'directed' ? HALF_SESSION_MS : HALF_SESSION_MS * 2;
  const remaining = started + duration - Date.now();
  if (remaining <= 0) { finishSession(match); return; }
  const timers = [];
  if (duration === HALF_SESSION_MS * 2 && started + HALF_SESSION_MS > Date.now()) {
    timers.push(setTimeout(() => { if (match.status === 'in_progress') emitSessionState(match, 'session-phase'); }, started + HALF_SESSION_MS - Date.now()));
  }
  timers.push(setTimeout(() => finishSession(match), remaining));
  timers.forEach(timer => timer.unref());
  sessionTimers.set(match.id, timers);
}

function acknowledge(callback, packet) { if (typeof callback === 'function') callback(packet); }
function reject(socket, callback, error) {
  acknowledge(callback, { ok: false, error });
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
    socket.emit('notifications', state.notifications);
    socket.emit('history', state.history);
  });

  socket.on('find-match', (input, callback) => {
    const active = activeMatchFor(email);
    if (active) {
      acknowledge(callback, { ok: true, activeMatch: publicMatch(active, email) });
      return socket.emit('match-found', publicMatch(active, email));
    }
    if (input?.practiceMode != null && !PRACTICE_MODES.includes(input.practiceMode)) return reject(socket, callback, 'Choose peer practice, candidate, or interviewer mode.');
    const oldStats = db.profiles[email]?.stats || { sessionsCompleted: 0, ratingTotal: 0, averageRating: 0 };
    const profile = {
      email,
      name: cleanText(input?.name, 40),
      languages: cleanList(input?.languages, null, 12),
      slots: cleanList(input?.slots, null, 3),
      interviewType: questionBank[input?.interviewType] ? input.interviewType : '',
      experience: levels.includes(input?.experience) ? input.experience : 'Beginner',
      spokenLanguage: ['English', 'Hindi', 'English + Hindi'].includes(input?.spokenLanguage) ? input.spokenLanguage : 'English',
      practiceMode: practiceMode(input),
      timezone: cleanText(input?.timezone, 60),
      status: 'waiting',
      stats: oldStats,
      updatedAt: new Date().toISOString()
    };
    if (!profile.name || !profile.languages.length || !profile.slots.length || !profile.interviewType) return reject(socket, callback, 'Please complete all matching preferences.');
    if (profile.slots.some(slot => !Number.isFinite(Date.parse(slot)) || Date.parse(slot) <= Date.now())) return reject(socket, callback, 'Choose an upcoming session time. Your previous time may have passed.');
    profile.slots = [...new Set(profile.slots.map(slot => new Date(slot).toISOString()))];
    db.profiles[email] = profile;
    const found = bestMatch(profile);
    if (!found) { save(); acknowledge(callback, { ok: true, waiting: true, profile }); return socket.emit('match-waiting'); }

    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const match = {
      id: roomId,
      people: [profile, found.candidate],
      score: found.result.value,
      reasons: found.result.reasons,
      sharedSlot: found.result.sharedSlot,
      interviewType: profile.interviewType,
      sessionMode: profile.practiceMode === 'peer' ? 'peer' : 'directed',
      durationMinutes: profile.practiceMode === 'peer' ? 90 : 45,
      status: 'matched',
      createdAt: new Date().toISOString(),
      questions: { [profile.email]: questionFor(profile.interviewType, 0), [found.candidate.email]: questionFor(profile.interviewType, 1) },
      workspace: { code: '', language: profile.languages[0] || 'JavaScript', version: 0 },
      chat: [],
      feedback: {}
    };
    db.matches[roomId] = match;
    db.profiles[profile.email].status = 'matched';
    db.profiles[found.candidate.email].status = 'matched';
    save();
    acknowledge(callback, { ok: true, activeMatch: publicMatch(match, email) });
    match.people.forEach(person => {
      const peer = match.people.find(other => other.email !== person.email);
      notify(person, 'Your Mocksyra match is ready', `You matched with ${peer.name} for ${match.interviewType} at the same available time.`, roomId);
      emitToEmail(person.email, 'match-found', publicMatch(match, person.email));
    });
  });

  socket.on('cancel-search', callback => {
    if (activeMatchFor(email)) return reject(socket, callback, 'A match is already ready. Open it to join or cancel.');
    if (db.profiles[email]?.status === 'waiting') { db.profiles[email].status = 'idle'; save(); }
    acknowledge(callback, { ok: true });
  });

  socket.on('cancel-match', (roomIdValue, callback) => {
    const roomId = cleanText(typeof roomIdValue === 'object' ? roomIdValue?.roomId : roomIdValue, 100);
    const match = authorizedMatch(socket, roomId);
    if (!canUseRoom(match, email, false, 'cancel')) return reject(socket, callback, 'Only a match that has not started can be cancelled.');
    match.status = 'cancelled';
    match.cancelledAt = new Date().toISOString();
    clearSessionTimers(roomId);
    match.people.forEach(person => {
      if (db.profiles[person.email]?.status === 'matched') db.profiles[person.email].status = 'idle';
    });
    save();
    match.people.forEach(person => emitToEmail(person.email, 'match-cancelled', { roomId, message: 'This match was cancelled. You can choose new preferences and find another match.' }));
    io.in(roomId).socketsLeave(roomId);
    acknowledge(callback, { ok: true });
  });

  socket.on('join-session', (roomIdValue, callback) => {
    const roomId = cleanText(roomIdValue, 100), match = authorizedMatch(socket, roomId);
    if (!match || !['matched', 'in_progress'].includes(match.status)) return reject(socket, callback, 'This interview room is unavailable.');
    if (match.status === 'in_progress') scheduleSessionTimers(match);
    if (match.status !== 'matched' && match.status !== 'in_progress') return reject(socket, callback, 'This interview has ended. Please share your feedback.');
    socket.join(roomId);
    const peer = match.people.find(person => person.email !== email);
    emitToEmail(peer.email, 'peer-entered-room');
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
    socket.leave(roomId);
    if (!roomParticipantEmails(roomId).has(email)) socket.to(roomId).emit('peer-left', { roomId });
    acknowledge(callback, { ok: true });
  });

  socket.on('signal', packet => {
    const valid = validRoomPacket(socket, packet);
    if (!valid || !packet.data || typeof packet.data !== 'object') return;
    socket.to(valid.roomId).emit('signal', packet.data);
  });

  socket.on('workspace-request', roomIdValue => {
    const roomId = cleanText(roomIdValue, 100), match = authorizedMatch(socket, roomId);
    if (!canUseRoom(match, email, socket.rooms.has(roomId))) return;
    socket.emit('workspace-state', match.workspace || { code: '', language: 'JavaScript', version: 0 });
    socket.emit('chat-state', match.chat || []);
  });

  socket.on('workspace-update', packet => {
    const valid = validRoomPacket(socket, packet); if (!valid) return;
    const workspace = valid.match.workspace || { version: 0 };
    valid.match.workspace = { code: String(packet.code || '').slice(0, 20_000), language: cleanText(packet.language, 30) || 'Plain text', version: Number(workspace.version || 0) + 1, updatedBy: email };
    save(); io.to(valid.roomId).emit('workspace-update', valid.match.workspace);
  });

  socket.on('chat-message', packet => {
    const valid = validRoomPacket(socket, packet); if (!valid) return;
    const message = cleanText(packet.message, 500); if (!message) return;
    const profile = valid.match.people.find(person => person.email === email);
    const item = { id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: profile.name, message, createdAt: new Date().toISOString() };
    valid.match.chat = [...(valid.match.chat || []), item].slice(-50); save(); io.to(valid.roomId).emit('chat-message', item);
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
    emitToEmail(peer.email, 'peer-feedback-submitted');
    const completed = finishFeedback(match, db.profiles);
    acknowledge(callback, { ok: true, submitted: true, completed, selfFeedback: feedback });
    if (!completed) return;
    save();
    match.people.forEach(person => {
      const other = match.people.find(candidate => candidate.email !== person.email);
      emitToEmail(person.email, 'feedback-ready', feedbackWithCriteria(match, other.email));
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

app.get('/health', (_, response) => response.status(200).json({ status: 'ok', persistence: SUPABASE_SECRET_KEY ? 'supabase' : 'local' }));
const publicAssets = new Set(['index.html', 'styles.css', 'call.css', 'features.css', 'design.css', 'app.js', 'auth.js', 'supabase.js', 'runtime-config.js', 'site-config.js', 'runner.html', 'runner.js']);
app.get('*', (request, response) => {
  const asset = request.path === '/' ? 'index.html' : request.path.slice(1);
  if (!publicAssets.has(asset)) return response.status(404).type('text').send('Not found');
  response.sendFile(path.join(__dirname, asset));
});

const port = process.env.PORT || 3000;
async function start() {
  await loadRemoteState();
  Object.values(db.matches).forEach(scheduleSessionTimers);
  return server.listen(port, () => console.log(`Mocksyra is running at http://localhost:${port}`));
}

if (require.main === module) start();
module.exports = { app, server, compatibility, sharedSlots, sharedSkills, questionFor, publicMatch, historyFor };
