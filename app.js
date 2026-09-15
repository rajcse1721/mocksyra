const root = document.querySelector('#app');
const socket = io((['localhost', '127.0.0.1'].includes(location.hostname) ? location.origin : window.MOCKSYRA_SOCKET_URL) || location.origin, {
  autoConnect: false,
  timeout: 90000,
  transports: ['websocket', 'polling']
});

const PROFILE_KEY = 'mocksyra-profile';
const EMAIL_KEY = 'mocksyra-email';
const skills = window.MOCKSYRA_SITE?.technologies || ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'React', 'Node.js', 'Spring Boot', 'SQL', 'AWS'];
const interviewTypes = ['Data Structures & Algorithms', 'Frontend', 'Backend', 'System Design', 'Behavioral', 'SQL'];

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
};

const state = {
  profile: readJson(PROFILE_KEY, null),
  authUser: null,
  match: null,
  roomId: null,
  notifications: [],
  history: [],
  listings: [],
  serverNow: null,
  pendingCandidates: [],
  dailyCall: null,
  workspace: { code: '', language: 'JavaScript', version: 0 },
  chat: [],
  selectedMode: sessionStorage.getItem('mocksyra-mode') || null,
  activeRoute: '',
  authenticated: Boolean(localStorage.getItem(EMAIL_KEY)),
  restored: false
};

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));

const go = route => { location.hash = route; };
const toast = (message, duration = 3200) => {
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite');
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), duration);
};


const modes = {
  candidate: { title: 'Candidate', icon: 'user', duration: 45, target: 'an interviewer', description: 'Answer interview questions and receive useful feedback.' },
  interviewer: { title: 'Interviewer', icon: 'briefcase', duration: 45, target: 'a candidate', description: 'Lead the interview and help a candidate improve.' }
};
const normalizedMode = value => modes[value] ? value : 'candidate';
const currentDisplayName = () => {
  const metadata = state.authUser?.user_metadata || {};
  const emailName = (state.authUser?.email || localStorage.getItem(EMAIL_KEY) || '').split('@')[0].replace(/[._-]+/g, ' ');
  return state.profile?.name || metadata.full_name || metadata.name || emailName || 'Your account';
};
const modeFor = () => modes[normalizedMode(state.match?.practiceMode || state.profile?.practiceMode)];
const sessionMinutes = () => Number(state.match?.durationMinutes) || 45;
const closedMatch = match => !match || ['completed', 'cancelled', 'expired'].includes(match.status);
const icon = name => {
  const paths = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 20v-2a7 7 0 0 1 14 0v2M17 5a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5"/>',
    briefcase: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12a20 20 0 0 0 18 0M12 12v4"/>',
    mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    micOff: '<path d="m2 2 20 20M9 9v3a3 3 0 0 0 5 2M9 4a3 3 0 0 1 6 1v5M5 10v2a7 7 0 0 0 12 5M19 10v2m-7 7v3m-4 0h8"/>',
    camera: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-4v12l-6-4"/>',
    cameraOff: '<path d="m2 2 20 20M16 10l6-4v12l-6-4M2 6v11a2 2 0 0 0 2 2h10M8 5h6a2 2 0 0 1 2 2v5"/>',
    phone: '<path d="M3 15a16 16 0 0 1 18 0l-2 5-5-2v-4h-4v4l-5 2z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-4-15-2 18"/>',
    chat: '<path d="M21 11a9 9 0 0 1-9 9H3l1-5a9 9 0 1 1 17-4z"/>',
    note: '<path d="M14 2H4v20h16V8zM14 2v6h6M8 12h8m-8 4h6"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
};
function frame(content) {
  const name = currentDisplayName();
  const unread = state.notifications.filter(item => !item.read).length;
  return `<div class="app-shell">
    <header class="app-nav"><div class="shell app-nav-main">
      <a class="brand" href="#home"><i>◒</i> Mocksyra</a>
      <nav class="app-sections" aria-label="Main"><button class="text-button" data-route="marketplace">Sessions</button><button class="nav-activity" data-route="activity">History${unread ? `<span>${unread}</span>` : ''}</button></nav>
      <nav class="profile-menu" aria-label="Account">
        <span class="mini-avatar">${escapeHtml(name[0] || 'Y')}</span>
        <span>${escapeHtml(name)}</span><button class="text-button" id="logout">Log out</button>
      </nav>
    </div></header><main class="app-main"><div class="shell">${content}</div></main></div>`;
}
function bindRoutes(scope = root) {
  scope.querySelectorAll('[data-route]').forEach(element => {
    element.onclick = () => {
      if (element.dataset.mode) {
        state.selectedMode = normalizedMode(element.dataset.mode);
        sessionStorage.setItem('mocksyra-mode', state.selectedMode);
      }
      go(element.dataset.route);
    };
  });
}
let connectionPromise;
async function connectSocket() {
  if (socket.connected) return true;
  if (connectionPromise) return connectionPromise;
  const { data } = await window.peerSupabase.auth.getSession();
  if (!data.session) return false;
  socket.auth = { accessToken: data.session.access_token };
  connectionPromise = new Promise(resolve => {
    const finish = success => {
      clearTimeout(timeout);
      socket.off('connect', onConnect); socket.off('connect_error', onError);
      connectionPromise = null; resolve(success);
    };
    const onConnect = () => finish(true);
    const onError = error => { toast(error.message === 'Authentication required' ? 'Please sign in again.' : 'Connection unavailable. Your preferences are saved; please retry.'); finish(false); };
    const timeout = setTimeout(() => { toast('The server is taking a little longer. Please retry.'); finish(false); }, 95000);
    socket.once('connect', onConnect); socket.once('connect_error', onError); socket.connect();
  });
  return connectionPromise;
}
window.connectMocksyraSocket = connectSocket;
function request(event, payload, timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!socket.connected) return resolve({ ok: false, error: 'You are offline. Please reconnect and try again.' });
    const timeout = setTimeout(() => resolve({ ok: false, error: 'No response yet. Please try again.' }), timeoutMs);
    socket.emit(event, payload, result => { clearTimeout(timeout); resolve(result || { ok: true }); });
  });
}
function home() {
  root.innerHTML = document.querySelector('#landing-template').innerHTML;
  const account = root.querySelector('.simple-landing-nav .button');
  account.textContent = state.authenticated ? 'Open sessions' : 'Sign in';
  account.dataset.route = 'marketplace';
  bindRoutes();
  root.querySelectorAll('[data-scroll]').forEach(element => element.onclick = event => {
    event.preventDefault();
    document.getElementById(element.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' });
  });
}

function availableSlots() {
  const now = new Date();
  const slots = [];
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() + dayOffset);
    for (let hour = 8; hour <= 22; hour += 2) {
      const start = new Date(date);
      start.setHours(hour, 0, 0, 0);
      if (start.getTime() < now.getTime() + 60 * 60 * 1000) continue;
      slots.push({
        value: start.toISOString(),
        label: `${dayOffset === 0 ? 'Today' : 'Tomorrow'} · ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      });
    }
  }
  return slots;
}

function onboarding() {
  const previous = state.profile || {};
  let selectedMode = normalizedMode(state.selectedMode || previous.practiceMode);
  const slots = availableSlots();
  const previousSlot = (previous.slots || []).find(value => Date.parse(value) > Date.now());
  if (previousSlot && !slots.some(slot => slot.value === previousSlot)) slots.unshift({ value: previousSlot, label: formatSlot(previousSlot) });
  let selectedSlot = previousSlot || slots[0]?.value || '';
  let selectedTechnology = previous.languages?.[0] || skills[0];
  const currentMatch = !closedMatch(state.match);
  root.innerHTML = frame(`<section class="simple-page onboarding-page">
    <header class="simple-page-heading"><p class="eyebrow">SET UP AN INTERVIEW</p><h1 class="page-title">Choose your role and time.</h1>
    <p class="page-subtitle">Every interview has one candidate and one interviewer. Sessions last 45 minutes.</p></header>
    ${currentMatch ? '<div class="notice">You already have a session waiting. <button class="text-button" data-route="match">Open your booking →</button></div>' : ''}
    <form id="preferences-form" class="panel onboarding-form clean-form">
      <fieldset class="role-fieldset"><legend class="field-label">I want to join as</legend><div class="role-selector" role="group" aria-label="Interview role">
        ${['candidate', 'interviewer'].map(key => `<button type="button" class="role-option ${selectedMode === key ? 'selected' : ''}" data-mode="${key}" aria-pressed="${selectedMode === key}">${icon(modes[key].icon)}<span><b>${modes[key].title}</b><small>${modes[key].description}</small></span></button>`).join('')}
      </div></fieldset><p class="role-help" id="role-help"></p>
      <div class="simple-form-grid">
        <div><label class="field-label" for="name">Display name</label><input id="name" class="textarea input" maxlength="40" required autocomplete="nickname" value="${escapeHtml(previous.name || currentDisplayName())}" placeholder="Your name"></div>
        <div><label class="field-label" for="interview-type">Interview focus</label><select id="interview-type" class="select">${interviewTypes.map(value => `<option ${value === previous.interviewType ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div>
        <div><label class="field-label" for="technology">Technology</label><select id="technology" class="select">${skills.map(value => `<option ${value === selectedTechnology ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div>
        <div><label class="field-label" for="session-time">Available time</label><select id="session-time" class="select">${slots.map(slot => `<option value="${escapeHtml(slot.value)}" ${slot.value === selectedSlot ? 'selected' : ''}>${escapeHtml(slot.label)}</option>`).join('')}</select><small class="input-help">Shown in ${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}</small></div>
      </div>
      <p id="preference-error" class="form-error" role="alert"></p>
      <div class="clean-form-actions"><span>Free · 45 minutes · Live video</span><button type="submit" class="button" id="publish" ${currentMatch ? 'disabled' : ''}><span id="publish-label"></span></button></div>
    </form></section>`);
  bindRoutes();
  const updateRole = () => {
    root.querySelector('#role-help').textContent = selectedMode === 'candidate' ? 'You will answer questions from an interviewer.' : 'You will guide a candidate through the interview.';
    root.querySelector('#publish-label').textContent = selectedMode === 'candidate' ? 'Publish Candidate time' : 'Publish Interviewer time';
  };
  root.querySelectorAll('.role-option').forEach(button => button.onclick = () => {
    selectedMode = button.dataset.mode; state.selectedMode = selectedMode; sessionStorage.setItem('mocksyra-mode', selectedMode);
    root.querySelectorAll('.role-option').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button); });
    updateRole();
  });
  root.querySelector('#preferences-form').onsubmit = async event => {
    event.preventDefault();
    const error = root.querySelector('#preference-error'), button = root.querySelector('#publish');
    const name = root.querySelector('#name').value.trim();
    selectedTechnology = root.querySelector('#technology').value; selectedSlot = root.querySelector('#session-time').value;
    if (!name || !selectedTechnology || !selectedSlot) { error.textContent = 'Add your name, technology, and available time.'; return; }
    state.profile = { ...previous, name, practiceMode: selectedMode, languages: [selectedTechnology], slots: [selectedSlot],
      interviewType: root.querySelector('#interview-type').value, experience: previous.experience || 'Beginner',
      spokenLanguage: previous.spokenLanguage || 'English', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
    button.disabled = true;
    button.textContent = 'Connecting…'; error.textContent = '';
    if (!(await connectSocket())) { button.disabled = false; button.textContent = 'Try again'; error.textContent = 'Could not reach sessions. Your preferences are saved.'; return; }
    saveProfileToSupabase(state.profile);
    button.textContent = 'Publishing…';
    const result = await request('publish-listing', state.profile);
    if (!result.ok) { button.disabled = false; button.textContent = 'Try again'; error.textContent = result.error; return; }
    if (result.listings) state.listings = result.listings;
    if (result.profile) { state.profile = { ...state.profile, ...result.profile }; localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); }
    if (result.serverNow) state.serverNow = result.serverNow;
    if (result.activeMatch) { state.match = result.activeMatch; state.roomId = result.activeMatch.roomId; return go('match'); }
    if (location.hash === '#onboarding') go('marketplace');
  };
  updateRole();
}
async function saveProfileToSupabase(profile) {
  try {
    const { data } = await window.peerSupabase.auth.getUser();
    if (!data.user) return;
    await window.peerSupabase.from('profiles').upsert({
      id: data.user.id, display_name: profile.name, languages: profile.languages,
      preferred_slot: profile.slots[0], availability: profile.slots,
      interview_type: profile.interviewType, experience_level: profile.experience,
      spoken_language: profile.spokenLanguage, timezone: profile.timezone, practice_mode: normalizedMode(profile.practiceMode),
      updated_at: new Date().toISOString()
    });
  } catch { /* Realtime matching still works if optional profile sync fails. */ }
}

async function refreshMarketplace(showLoading = true) {
  const results = root.querySelector('#marketplace-results');
  if (showLoading && results) { results.setAttribute('aria-busy', 'true'); results.innerHTML = '<p class="empty-state">Refreshing available sessions…</p>'; }
  if (!(await connectSocket())) {
    if (results) results.innerHTML = '<p class="empty-state" role="alert">Could not reach the session marketplace. Please try again.</p>';
    return;
  }
  const response = await request('browse-listings', {});
  if (!response.ok) {
    if (results) results.innerHTML = `<p class="empty-state" role="alert">${escapeHtml(response.error)}</p>`;
    return;
  }
  state.listings = response.listings || [];
  state.serverNow = response.serverNow || state.serverNow;
  renderMarketplaceResults();
}

function renderMarketplaceResults() {
  const results = root.querySelector('#marketplace-results');
  if (!results) return;
  const sessions = state.listings.flatMap(listing => (listing.slots || []).map(slot => ({ ...listing, slot })));
  sessions.sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
  const count = root.querySelector('#marketplace-count');
  if (count) count.textContent = `${sessions.length} available session${sessions.length === 1 ? '' : 's'}`;
  results.setAttribute('aria-busy', 'false');
  if (!sessions.length) {
    results.innerHTML = '<section class="marketplace-empty"><h2>No open sessions right now</h2><p>Add your availability below and another person can book it.</p></section>';
    return;
  }
  const hasActiveMatch = !closedMatch(state.match);
  results.innerHTML = sessions.map(listing => {
    const requiredRole = listing.requiredRole || (listing.practiceMode === 'candidate' ? 'interviewer' : 'candidate');
    const offer = listing.practiceMode === 'interviewer' ? 'Interviewer available' : 'Candidate looking for an interviewer';
    return `<article class="session-card" role="listitem" data-listing-id="${escapeHtml(listing.listingId)}">
    <header class="session-card-person"><span class="listing-avatar">${escapeHtml(listing.name?.[0] || '?')}</span><div><span class="session-role">${offer}</span><h2>${escapeHtml(listing.name)}</h2><p>${escapeHtml(listing.experience)} · ${escapeHtml(listing.spokenLanguage)}</p></div></header>
    <div class="session-card-main"><div><h3>${escapeHtml(listing.interviewType)}</h3><p>${escapeHtml((listing.languages || []).slice(0, 3).join(' · '))}</p></div><div class="session-card-time"><time datetime="${escapeHtml(listing.slot)}">${escapeHtml(formatSlot(listing.slot))}</time><span>45 minutes</span></div></div>
    <div class="session-card-actions"><button class="button" data-book-listing="${escapeHtml(listing.listingId)}" data-book-role="${requiredRole}" data-slot="${escapeHtml(listing.slot)}" aria-label="Book with ${escapeHtml(listing.name)} as ${requiredRole}" ${hasActiveMatch ? 'disabled' : ''}>${hasActiveMatch ? 'You already have an interview' : `Book as ${modes[requiredRole].title}`}</button></div><p class="session-card-error" role="alert"></p>
  </article>`;
  }).join('');
  root.querySelectorAll('[data-book-listing]').forEach(button => button.onclick = () => bookMarketplaceSession(button));
}

async function bookMarketplaceSession(button) {
  const card = button.closest('.session-card'), error = card.querySelector('.session-card-error');
  const listing = state.listings.find(item => item.listingId === button.dataset.bookListing);
  if (!listing) return refreshMarketplace(false);
  const role = listing.requiredRole || (listing.practiceMode === 'candidate' ? 'interviewer' : 'candidate');
  const bookingProfile = {
    ...(state.profile || {}),
    name: currentDisplayName(),
    practiceMode: role,
    languages: state.profile?.languages?.length ? state.profile.languages : listing.languages,
    slots: [button.dataset.slot],
    interviewType: listing.interviewType,
    experience: state.profile?.experience || 'Beginner',
    spokenLanguage: state.profile?.spokenLanguage || listing.spokenLanguage || 'English',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Reserving…'; error.textContent = '';
  const response = await request('book-listing', { listingId: button.dataset.bookListing, slot: button.dataset.slot, profile: bookingProfile });
  if (!response.ok) {
    error.textContent = response.error; button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = `Book as ${modes[role].title}`;
    await refreshMarketplace(false); return;
  }
  state.profile = { ...bookingProfile, ...(response.profile || {}) };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
  saveProfileToSupabase(state.profile);
  state.match = response.activeMatch; state.roomId = response.activeMatch.roomId;
  localStorage.setItem('mocksyra-active-match', JSON.stringify(response.activeMatch));
  go('match');
}

function marketplace() {
  const active = !closedMatch(state.match) ? state.match : null;
  const joinState = active ? scheduledJoinState(active) : null;
  const waiting = state.profile?.status === 'waiting';
  root.innerHTML = frame(`<section class="marketplace-page sessions-board" aria-labelledby="marketplace-title">
    <header class="marketplace-heading"><div><h1 class="page-title" id="marketplace-title" tabindex="-1">Interview sessions</h1><p class="page-subtitle">Book an open time or add your own availability.</p></div><button class="button" data-create-role="candidate">Create a session</button></header>
    ${active ? `<section class="upcoming-card"><div><span>Your next interview</span><h2>${escapeHtml(active.interviewType)} with ${escapeHtml(active.peer.name)}</h2><p>${escapeHtml(formatSlot(active.sharedSlot))} · You are the ${escapeHtml(modes[normalizedMode(active.practiceMode)].title)}</p></div><button class="button" data-route="match">${active.status === 'feedback_pending' ? 'Complete feedback' : joinState.allowed ? 'Join now' : 'View booking'}</button></section>` : ''}
    ${waiting ? `<div class="availability-inline"><span>Your ${escapeHtml(modes[normalizedMode(state.profile.practiceMode)].title)} slot is published for ${escapeHtml(formatSlot(state.profile.slots?.[0]))}.</span><button class="text-button" id="cancel-listing">Remove listing</button></div>` : ''}
    <section class="available-section"><div class="section-row"><div><h2>Available interviews</h2><p>Booking automatically gives you the opposite role.</p></div><p class="marketplace-count" id="marketplace-count" role="status" aria-live="polite">Loading…</p></div>
      <div id="marketplace-results" class="session-list" role="list" aria-busy="true"><p class="empty-state">Loading available sessions…</p></div>
    </section>
    <section class="offer-card"><div><h2>Don't see the right time?</h2><p>Publish one time and let the other person book it.</p></div><div><button class="button secondary" data-create-role="candidate">Offer as Candidate</button><button class="button secondary" data-create-role="interviewer">Offer as Interviewer</button></div></section>
  </section>`);
  bindRoutes();
  root.querySelector('#marketplace-title').focus({ preventScroll: true });
  root.querySelectorAll('[data-create-role]').forEach(button => button.onclick = () => {
    state.selectedMode = button.dataset.createRole;
    sessionStorage.setItem('mocksyra-mode', state.selectedMode);
    go('onboarding');
  });
  if (waiting) root.querySelector('#cancel-listing').onclick = async () => { const response = await request('cancel-search'); if (!response.ok) return toast(response.error); state.profile.status = 'idle'; localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); toast('Your listing was removed.'); marketplace(); };
  refreshMarketplace();
}

function search() {
  go('marketplace');
}

function formatSlot(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Time to be confirmed';
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const sameDay = target => date.getFullYear() === target.getFullYear() && date.getMonth() === target.getMonth() && date.getDate() === target.getDate();
  const prefix = sameDay(today) ? 'Today' : sameDay(tomorrow) ? 'Tomorrow' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${prefix} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

async function ensureMedia() {
  if (state.stream?.active) return true;
  try { state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); return true; }
  catch {
    try { state.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); toast('Camera unavailable. Audio-only mode is ready.'); return true; }
    catch { toast('Allow microphone access in your browser before joining.'); return false; }
  }
}

async function deviceCheck() {
  const status = root.querySelector('#device-status');
  status.textContent = 'Requesting permission…';
  if (!(await ensureMedia())) { status.textContent = 'Microphone and camera unavailable'; status.className = 'device-status error'; return; }
  const preview = root.querySelector('#device-preview');
  preview.srcObject = state.stream; preview.hidden = false;
  const audio = state.stream.getAudioTracks().length > 0, video = state.stream.getVideoTracks().length > 0;
  status.textContent = `${audio ? '✓ Microphone' : '✕ Microphone'} · ${video ? '✓ Camera' : 'Audio only'}`;
  status.className = 'device-status ready';
}

function scheduledJoinState(matchData) {
  if (!matchData?.opensAt) return { allowed: true, message: 'Room available' };
  const serverOffset = Number.isFinite(Date.parse(matchData.serverNow)) ? Date.parse(matchData.serverNow) - Date.now() : 0;
  const now = Date.now() + serverOffset, opens = Date.parse(matchData.opensAt), closes = Date.parse(matchData.closesAt);
  if (now < opens) return { allowed: false, message: `Room opens ${formatSlot(matchData.opensAt)}` };
  if (Number.isFinite(closes) && now > closes && matchData.status !== 'in_progress') return { allowed: false, message: 'This session’s join window has closed' };
  return { allowed: true, message: 'Your room is open' };
}

function match() {
  if (!state.match || !state.profile) return go('onboarding');
  const peer = state.match.peer;
  const feedbackPending = state.match.status === 'feedback_pending';
  const joinState = scheduledJoinState(state.match);
  const partnerRole = state.match.peerRole === 'candidate' ? 'Candidate' : 'Interviewer';
  root.innerHTML = frame(`<section class="simple-page booking-page">
    <header class="simple-page-heading"><h1 class="page-title">Your interview</h1><p class="page-subtitle">The private room opens shortly before the scheduled time.</p></header>
    <article class="booking-card">
      <div class="booking-partner"><span class="listing-avatar">${escapeHtml(peer.name?.[0] || '?')}</span><div><small>${partnerRole}</small><h2>${escapeHtml(peer.name)}</h2><p>${escapeHtml(peer.experience)}</p></div></div>
      <dl class="booking-details"><div><dt>Your role</dt><dd>${escapeHtml(modeFor().title)}</dd></div><div><dt>Interview</dt><dd>${escapeHtml(state.match.interviewType)}</dd></div><div><dt>When</dt><dd>${escapeHtml(formatSlot(state.match.sharedSlot))}</dd></div><div><dt>Duration</dt><dd>${sessionMinutes()} minutes</dd></div></dl>
      <p class="join-status" id="join-status">${feedbackPending ? 'Complete your feedback to finish this interview.' : escapeHtml(joinState.message)}</p>
      <div class="booking-actions"><button class="button secondary" id="test-devices">Test camera & mic</button><button class="button secondary" id="calendar">Add to calendar</button><button class="button" id="join" ${!feedbackPending && !joinState.allowed ? 'disabled' : ''}>${feedbackPending ? 'Continue to feedback' : joinState.allowed ? 'Join interview' : 'Room not open yet'}</button></div>
      <div class="device-check-inline"><video id="device-preview" autoplay muted playsinline hidden></video><p class="device-status" id="device-status">Camera and microphone not tested</p></div>
    </article>
    ${state.match.status === 'matched' ? '<button class="text-button cancel-match" id="cancel-match">Cancel interview</button>' : ''}
  </section>`);
  bindRoutes();
  root.querySelector('#test-devices').onclick = deviceCheck;
  root.querySelector('#calendar').onclick = downloadCalendar;
  root.querySelector('#cancel-match')?.addEventListener('click', async () => {
    if (!confirm('Cancel this match for both participants?')) return;
    const result = await request('cancel-match', state.roomId);
    if (!result.ok) return toast(result.error);
    clearActiveMatch(); go('marketplace');
  });
  root.querySelector('#join').onclick = async () => {
    if (feedbackPending) return go('feedback');
    if (!(await connectSocket())) return;
    if (state.match.videoProvider === 'daily') { endLocalCall(); return go('session'); }
    const prepared = await request('prepare-call', { roomId: state.roomId });
    if (!prepared.ok) return toast(prepared.error);
    if (await ensureMedia()) go('session');
  };
  clearInterval(state.joinClock);
  if (!feedbackPending) state.joinClock = setInterval(() => {
    const next = scheduledJoinState(state.match), button = root.querySelector('#join'), status = root.querySelector('#join-status');
    if (!button || !status) return clearInterval(state.joinClock);
    button.disabled = !next.allowed; button.textContent = next.allowed ? 'Join interview' : 'Room not open yet'; status.textContent = next.message;
  }, 30_000);
}

function calendarDate(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function downloadCalendar() {
  if (!state.match?.sharedSlot) return toast('No scheduled time is available.');
  const start = new Date(state.match.sharedSlot), end = new Date(start.getTime() + sessionMinutes() * 60 * 1000);
  const url = `${location.origin}${location.pathname}#match`;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mocksyra//Interview//EN', 'BEGIN:VEVENT',
    `UID:${state.roomId}@mocksyra`, `DTSTAMP:${calendarDate(new Date())}`, `DTSTART:${calendarDate(start)}`, `DTEND:${calendarDate(end)}`,
    `SUMMARY:Mocksyra interview with ${state.match.peer.name}`, `DESCRIPTION:Open Mocksyra to join your interview: ${url}`, `URL:${url}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); link.download = 'mocksyra-interview.ics'; link.click(); URL.revokeObjectURL(link.href);
}

function session() {
  const dailySession = state.match?.videoProvider === 'daily';
  if (!state.match || (!dailySession && !state.stream?.active)) return go('match');
  const peer = state.match.peer, question = state.match.question || {};
  const minutes = sessionMinutes(), initialTimer = `${minutes}:00`;
  const videoSurface = dailySession ? `<div class="call-stage daily-call-stage tool-panel" id="video-panel"><div class="call-top"><span class="live">● HOSTED VIDEO</span><span id="timer">${initialTimer}</span></div><p class="daily-status" id="daily-status">Preparing your private video room…</p><div class="daily-container" id="daily-container"></div><div class="daily-finish"><button class="call-action end" id="complete"><b>×</b><span>Finish interview</span></button></div></div>` : `<div class="call-stage tool-panel" id="video-panel"><div class="call-top"><span class="live">● LIVE SESSION</span><span id="timer">${initialTimer}</span></div>
        <div class="connection-banner" id="connection"><i></i><span>Waiting for ${escapeHtml(peer.name)} to join the room…</span></div>
        <div class="call-users"><div class="video"><video id="local" autoplay muted playsinline></video><small>You</small></div><div class="video"><video id="remote" autoplay playsinline></video><small id="peer-status">${escapeHtml(peer.name)} · not connected</small></div></div>
        <div class="call-controls"><button class="call-action" id="mic" title="Toggle microphone"><b>●</b><span>Microphone</span></button><button class="call-action" id="cam" title="Toggle camera"><b>◉</b><span>Camera</span></button><button class="call-action end" id="complete" title="Finish interview"><b>×</b><span>Finish</span></button></div></div>`;
  root.innerHTML = frame(`<section class="simple-page live-session-page">
    <header class="simple-session-heading"><div><p class="eyebrow">LIVE INTERVIEW</p><h1 class="page-title">${escapeHtml(state.match.interviewType)}</h1><p class="page-subtitle">You are the ${escapeHtml(modeFor().title.toLowerCase())} · with ${escapeHtml(peer.name)}</p></div><div class="simple-timer" id="side-timer">${initialTimer}</div></header>
    <div class="session-tools"><button class="tool-tab selected" data-tab="video-panel">Video</button><button class="tool-tab" data-tab="workspace-panel">Workspace</button></div>
    <section class="session-main">
      ${videoSurface}
      <div class="workspace-card tool-panel" id="workspace-panel" hidden><div class="workspace-head"><div><span class="eyebrow">LIVE SHARED PAD</span><h2 id="question-title">${escapeHtml(question.title || 'Collaborative workspace')}</h2></div><select id="code-language" class="select compact">${['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'SQL', 'Plain text'].map(value => `<option ${value === state.workspace.language ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="question-box" id="question-brief"><b>Interview question</b><p>${escapeHtml(question.prompt || 'Use the shared pad to work through your interview question.')}</p>${question.hints?.length ? `<details><summary>Hints for the interviewer</summary><ul>${question.hints.map(hint => `<li>${escapeHtml(hint)}</li>`).join('')}</ul></details>` : ''}</div>
        <textarea id="shared-code" class="code-editor" spellcheck="false">${escapeHtml(state.workspace.code || question.starter || '')}</textarea>
        <div class="workspace-actions"><span id="sync-status">Synced with your partner</span><button class="button secondary" id="copy-code">Copy</button><button class="button" id="run-code">Run JavaScript</button></div><pre id="code-output" class="code-output">Output will appear here.</pre></div>
    </section></section>`);
  bindRoutes();
  if (!dailySession) root.querySelector('#local').srcObject = state.stream;
  bindSessionTabs(); bindWorkspace();
  if (dailySession) prepareDailyCall(); else {
    prepareCall();
    root.querySelector('#mic').onclick = event => toggleTrack('audio', event.currentTarget);
    root.querySelector('#cam').onclick = event => toggleTrack('video', event.currentTarget);
  }
  root.querySelector('#complete').onclick = () => { if (confirm('Finish the interview for both participants and open feedback?')) socket.emit('complete-session', state.roomId); };
}

async function prepareDailyCall() {
  const status = root.querySelector('#daily-status'), container = root.querySelector('#daily-container');
  if (!window.DailyIframe) { status.textContent = 'The hosted video component could not load. Check your connection and refresh.'; status.classList.add('error'); return; }
  const access = await request('prepare-call', { roomId: state.roomId }, 30_000);
  if (!access.ok) { status.textContent = access.error; status.classList.add('error'); return; }
  if (access.provider !== 'daily') {
    state.match.videoProvider = 'webrtc';
    status.textContent = 'Using the browser video fallback…';
    if (await ensureMedia()) session();
    return;
  }
  const call = window.DailyIframe.createFrame(container, {
    showLeaveButton: true,
    iframeStyle: { width: '100%', height: '100%', border: '0', borderRadius: '8px' }
  });
  state.dailyCall = call;
  call.on('joined-meeting', async () => {
    status.textContent = 'Secure video connected.'; status.classList.add('ready');
    const joined = await request('join-session', state.roomId);
    if (!joined.ok) { status.textContent = joined.error; status.classList.add('error'); return; }
    if (joined.startedAt) startSyncedTimer(joined.startedAt);
    socket.emit('workspace-request', state.roomId);
  });
  call.on('left-meeting', () => { socket.emit('leave-session', state.roomId); if (state.dailyCall === call) state.dailyCall = null; try { call.destroy(); } catch {} if (location.hash === '#session') go('match'); });
  call.on('error', event => { status.textContent = event?.errorMsg || 'Video connection interrupted. Please retry.'; status.classList.add('error'); });
  try {
    await call.join({ url: access.roomUrl, token: access.token });
    access.token = '';
  } catch {
    status.textContent = 'Could not enter the hosted video room. Please refresh and retry.'; status.classList.add('error');
  }
}

function bindSessionTabs() {
  root.querySelectorAll('.tool-tab').forEach(button => button.onclick = () => {
    root.querySelectorAll('.tool-tab').forEach(item => item.classList.toggle('selected', item === button));
    root.querySelectorAll('.tool-panel').forEach(panel => { panel.hidden = panel.id !== button.dataset.tab; });
  });
}

function toggleTrack(kind, button) {
  const tracks = kind === 'audio' ? state.stream.getAudioTracks() : state.stream.getVideoTracks();
  tracks.forEach(track => { track.enabled = !track.enabled; });
  button.classList.toggle('off', tracks.length === 0 || !tracks[0].enabled);
  button.querySelector('span').textContent = tracks.length && tracks[0].enabled ? (kind === 'audio' ? 'Microphone' : 'Camera') : (kind === 'audio' ? 'Mic off' : 'Camera off');
}

function prepareCall() {
  state.pendingCandidates = []; state.offerStarted = false;
  const pc = state.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.stream.getTracks().forEach(track => pc.addTrack(track, state.stream));
  pc.ontrack = event => { const remote = root.querySelector('#remote'); if (remote) remote.srcObject = event.streams[0]; updateConnection(`${state.match.peer.name} · connected`, true); };
  pc.onicecandidate = event => { if (event.candidate) socket.emit('signal', { roomId: state.roomId, data: { candidate: event.candidate } }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') updateConnection('Connection failed — check network or try audio-only mode', false);
    if (pc.connectionState === 'disconnected') updateConnection('Video connection interrupted — retrying…', false);
  };
  socket.emit('join-session', state.roomId); socket.emit('workspace-request', state.roomId);
}

async function handleSignal(data) {
  const pc = state.pc; if (!pc) return;
  try {
    if (data.offer) { await pc.setRemoteDescription(data.offer); await flushCandidates(); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('signal', { roomId: state.roomId, data: { answer } }); }
    else if (data.answer) { await pc.setRemoteDescription(data.answer); await flushCandidates(); }
    else if (data.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else state.pendingCandidates.push(data.candidate); }
  } catch { updateConnection('Could not establish the video connection. Try rejoining.', false); }
}
async function flushCandidates() { while (state.pendingCandidates.length) await state.pc.addIceCandidate(state.pendingCandidates.shift()); }
function updateConnection(text, ready) {
  const status = root.querySelector('#peer-status'), banner = root.querySelector('#connection');
  if (status) status.textContent = text;
  if (banner) { banner.classList.toggle('ready', ready); banner.querySelector('span').textContent = ready ? 'Secure video connected' : text; }
}

function startSyncedTimer(startedAt) {
  clearInterval(state.clock); state.sessionStartedAt = new Date(startedAt).getTime();
  const update = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.sessionStartedAt) / 1000)), totalSeconds = sessionMinutes() * 60, remaining = Math.max(0, totalSeconds - elapsed);
    const value = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    const timer = root.querySelector('#timer'), side = root.querySelector('#side-timer'); if (timer) timer.textContent = value; if (side) side.textContent = value;
    if (!remaining) socket.emit('complete-session', state.roomId);
  };
  update(); state.clock = setInterval(update, 1000);
}

function bindWorkspace() {
  const editor = root.querySelector('#shared-code'), language = root.querySelector('#code-language'); let debounce;
  editor.oninput = () => { state.workspace.code = editor.value; clearTimeout(debounce); root.querySelector('#sync-status').textContent = 'Syncing…'; debounce = setTimeout(() => socket.emit('workspace-update', { roomId: state.roomId, code: editor.value, language: language.value }), 120); };
  language.onchange = () => { state.workspace.language = language.value; socket.emit('workspace-update', { roomId: state.roomId, code: editor.value, language: language.value }); };
  root.querySelector('#copy-code').onclick = async () => { await navigator.clipboard.writeText(editor.value); toast('Workspace copied.'); };
  root.querySelector('#run-code').onclick = () => runJavaScript(editor.value);
}

function runJavaScript(code) {
  const output = root.querySelector('#code-output');
  if (root.querySelector('#code-language').value !== 'JavaScript') return output.textContent = 'Local execution is currently available for JavaScript only.';
  output.textContent = 'Running…';
  const workerCode = `self.fetch=undefined;self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.importScripts=undefined;const lines=[];console.log=(...items)=>lines.push(items.map(item=>typeof item==='object'?JSON.stringify(item):String(item)).join(' '));console.error=console.log;self.onmessage=event=>{try{const result=new Function(event.data)();if(result!==undefined)lines.push(String(result));self.postMessage({lines});}catch(error){self.postMessage({error:error.message,lines});}};`;
  const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })));
  const timeout = setTimeout(() => { worker.terminate(); output.textContent = 'Execution stopped after 2 seconds.'; }, 2000);
  worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); output.textContent = [...event.data.lines, event.data.error ? `Error: ${event.data.error}` : ''].filter(Boolean).join('\n') || 'Completed with no output.'; };
  worker.postMessage(code);
}

function bindChat() {
  const send = () => { const input = root.querySelector('#chat-input'), message = input.value.trim(); if (!message) return; socket.emit('chat-message', { roomId: state.roomId, message }); input.value = ''; };
  root.querySelector('#send-chat').onclick = send; root.querySelector('#chat-input').onkeydown = event => { if (event.key === 'Enter') send(); };
}
function renderChat() {
  const container = root.querySelector('#chat-messages'); if (!container) return;
  container.innerHTML = state.chat.length ? state.chat.map(item => `<div class="chat-message"><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.message)}</span><small>${new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div>`).join('') : '<p class="empty-state">No messages yet.</p>';
  container.scrollTop = container.scrollHeight;
}

function endLocalCall() {
  clearInterval(state.clock); clearInterval(state.joinClock);
  state.stream?.getTracks().forEach(track => track.stop()); state.pc?.close(); state.stream = null; state.pc = null;
  const daily = state.dailyCall; state.dailyCall = null;
  if (daily) { Promise.resolve(daily.leave()).catch(() => {}).finally(() => { try { daily.destroy(); } catch {} }); }
}

function feedback() {
  if (!state.match) return go('activity');
  const peer = state.match.peer;
  const criteria = Array.isArray(state.match.feedbackCriteria) && state.match.feedbackCriteria.length === 3
    ? state.match.feedbackCriteria
    : ['Problem solving', 'Communication', 'Technical depth'];
  root.innerHTML = frame(`<section class="simple-page feedback-page"><header class="simple-page-heading"><p class="eyebrow">INTERVIEW COMPLETE</p><h1 class="page-title">Share useful feedback.</h1><p class="page-subtitle">Your partner sees it after both of you submit.</p></header>
    <section class="panel feedback-card"><h2>Feedback for ${escapeHtml(peer.name.split(' ')[0])}</h2>
      ${criteria.map((criterion, index) => `<label class="field-label">${criterion.toUpperCase()}</label><div class="rating-row" data-index="${index}">${[1, 2, 3, 4, 5].map(score => `<button data-score="${score}" aria-label="${score} stars">★</button>`).join('')}</div>`).join('')}
      <div class="feedback-fields"><label><span class="field-label">WHAT WENT WELL?</span><textarea id="strength" class="textarea" maxlength="1200" placeholder="Be specific and useful."></textarea></label><label><span class="field-label">ONE AREA TO IMPROVE</span><textarea id="improve" class="textarea" maxlength="1200" placeholder="Suggest one actionable next step."></textarea></label></div>
      <label class="field-label">BOOK ANOTHER INTERVIEW TOGETHER?</label><div class="choices"><button type="button" class="choice" data-repeat="yes">Yes</button><button type="button" class="choice" data-repeat="no">Not now</button></div>
      <div class="clean-form-actions"><span>Private between both participants</span><button type="button" class="button" id="submit">Submit feedback ${icon('arrow')}</button></div></section></section>`);
  bindRoutes(); const scores = [0, 0, 0]; let practiseAgain = null;
  root.querySelectorAll('.rating-row').forEach(row => row.querySelectorAll('button').forEach(button => button.onclick = () => {
    const index = Number(row.dataset.index), score = Number(button.dataset.score); scores[index] = score;
    row.querySelectorAll('button').forEach(item => item.classList.toggle('selected', Number(item.dataset.score) <= score));
  }));
  root.querySelectorAll('[data-repeat]').forEach(button => button.onclick = () => { practiseAgain = button.dataset.repeat === 'yes'; root.querySelectorAll('[data-repeat]').forEach(item => item.classList.toggle('selected', item === button)); });
  root.querySelector('#submit').onclick = () => {
    const strength = root.querySelector('#strength').value.trim(), improve = root.querySelector('#improve').value.trim();
    if (scores.some(score => !score)) return toast(`Please rate all ${criteria.length} areas.`);
    if (strength.length < 5 || improve.length < 5) return toast('Add a short strength and an actionable improvement.');
    const button = root.querySelector('#submit'); button.disabled = true; button.textContent = 'Waiting for partner…';
    socket.emit('submit-feedback', { roomId: state.roomId, feedback: { scores, strength, improve, practiseAgain } });
  };
}

function dashboard() {
  if (!state.feedback || !state.profile || !state.match) return go('activity');
  const feedback = state.feedback, average = (feedback.scores.reduce((sum, score) => sum + score, 0) / feedback.scores.length).toFixed(1);
  root.innerHTML = frame(`<section class="simple-page result-page"><header class="simple-page-heading"><p class="eyebrow">INTERVIEW COMPLETE</p><h1 class="page-title">Nice work, ${escapeHtml(state.profile.name.split(' ')[0])}.</h1><p class="page-subtitle">Your feedback is saved in Activity.</p></header>
    <section class="panel result-card"><div class="result-rating"><span>${average}/5</span><p>Feedback from ${escapeHtml(state.match.peer.name)}</p></div><div class="feedback-item"><b>What went well</b>${escapeHtml(feedback.strength || 'No written feedback provided.')}</div><div class="feedback-item"><b>Focus for next time</b>${escapeHtml(feedback.improve || 'Keep practising clear problem decomposition.')}</div><div class="booking-actions"><button class="button" data-route="marketplace">Find another interview</button><button class="button secondary" data-route="activity">View activity</button></div></section></section>`);
  bindRoutes();
}

function activity() {
  const completed = state.history.length;
  root.innerHTML = frame(`<section class="simple-page activity-page"><header class="simple-page-heading"><p class="eyebrow">ACTIVITY</p><h1 class="page-title">Your interviews</h1><p class="page-subtitle">${completed} completed interview${completed === 1 ? '' : 's'}.</p></header>
    ${state.match ? '<div class="notice">You have an upcoming interview. <button class="text-button" data-route="match">Open booking →</button></div>' : ''}
    <section class="panel"><div class="panel-heading"><h2>Interview history</h2><button class="button secondary" data-route="marketplace">Find an interview</button></div>
      <div class="history-list">${state.history.length ? state.history.map((item, index) => `<article class="history-card"><div><span class="match-badge">${escapeHtml(item.interviewType)}</span><h3>${escapeHtml(item.peer.name)}</h3><p>${escapeHtml(formatSlot(item.sharedSlot))} · ${escapeHtml(item.peer.experience)}</p></div><div><b>${item.feedbackReceived ? `${(item.feedbackReceived.scores.reduce((a, b) => a + b, 0) / 3).toFixed(1)}/5` : 'Pending'}</b><button class="text-button" data-summary="${index}">Download summary</button></div></article>`).join('') : '<p class="empty-state">Complete your first interview to build a feedback history.</p>'}</div>
    </section><details class="notification-drawer"><summary>Recent updates (${state.notifications.length})</summary><div class="notification-drawer-actions"><button class="text-button" id="enable-alerts">Enable browser alerts</button></div><div class="notification-list">${state.notifications.length ? state.notifications.map(item => `<article><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.body)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></article>`).join('') : '<p class="empty-state">No updates yet.</p>'}</div></details></section>`);
  bindRoutes();
  root.querySelector('#enable-alerts').onclick = async () => {
    if (!('Notification' in window)) return toast('Browser notifications are not supported here.');
    const result = await Notification.requestPermission(); toast(result === 'granted' ? 'Browser alerts enabled while your browser is running.' : 'Notification permission was not enabled.');
  };
  root.querySelectorAll('[data-summary]').forEach(button => button.onclick = () => downloadSummary(state.history[Number(button.dataset.summary)]));
}

function downloadSummary(item) {
  const feedbackData = item.feedbackReceived;
  const text = ['MOCKSYRA SESSION SUMMARY', `Partner: ${item.peer.name}`, `Role: ${modes[normalizedMode(item.practiceMode)]?.title || 'Candidate'}`, `Type: ${item.interviewType}`, `Time: ${formatSlot(item.sharedSlot)}`, '', 'WHAT WENT WELL', feedbackData?.strength || 'Feedback pending', '', 'FOCUS FOR NEXT TIME', feedbackData?.improve || 'Feedback pending'].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  link.download = `mocksyra-${new Date(item.completedAt || Date.now()).toISOString().slice(0, 10)}.txt`; link.click(); URL.revokeObjectURL(link.href);
}

function showSystemNotification(item) {
  toast(item.title);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(item.title, { body: item.body });
}

function clearActiveMatch() {
  endLocalCall();
  state.match = null; state.roomId = null; state.feedback = null;
  localStorage.removeItem('mocksyra-active-match');
}

socket.on('connect', () => socket.emit('restore-profile'));
socket.on('match-waiting', () => toast('Your availability is live. We will notify you when an interview is booked.'));
socket.on('match-found', matchData => {
  state.match = matchData; state.roomId = matchData.roomId; localStorage.setItem('mocksyra-active-match', JSON.stringify(matchData));
  if (location.hash === '#marketplace') marketplace();
  else if (['#search', '#onboarding'].includes(location.hash)) go('match');
  else showSystemNotification({ title: 'Your Mocksyra match is ready', body: `You matched with ${matchData.peer.name}.` });
});
socket.on('match-cancelled', packet => {
  if (!packet?.roomId || packet.roomId === state.roomId) clearActiveMatch();
  toast(packet?.message || 'This interview was cancelled.');
  if (!['#home', '#auth'].includes(location.hash)) go('marketplace');
});
socket.on('profile-state', restored => {
  if (restored?.profile) { state.profile = { ...state.profile, ...restored.profile }; localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); }
  if (restored?.activeMatch) { state.match = restored.activeMatch; state.roomId = restored.activeMatch.roomId; localStorage.setItem('mocksyra-active-match', JSON.stringify(restored.activeMatch)); }
  else if (restored && Object.hasOwn(restored, 'activeMatch') && state.match && location.hash !== '#feedback') clearActiveMatch();
  if (Array.isArray(restored?.history)) state.history = restored.history;
  if (Array.isArray(restored?.notifications)) state.notifications = restored.notifications;
  if (location.hash === '#marketplace' && restored && Object.hasOwn(restored, 'activeMatch')) marketplace();
});
socket.on('session-listings', listings => { state.listings = listings || []; if (location.hash === '#marketplace') renderMarketplaceResults(); });
socket.on('listings-updated', () => { if (location.hash === '#marketplace') refreshMarketplace(false); });
socket.on('notifications', notifications => { state.notifications = notifications || []; if (location.hash === '#activity') activity(); });
socket.on('notification', notification => { state.notifications = [notification, ...state.notifications.filter(item => item.id !== notification.id)]; showSystemNotification(notification); if (location.hash === '#activity') activity(); });
socket.on('history', history => { state.history = history || []; if (location.hash === '#activity') activity(); });
socket.on('peer-entered-room', () => { toast('Your interview partner entered the room.'); const button = root.querySelector('#join'); if (button) { button.textContent = 'Partner is ready — join now'; button.classList.add('button-light'); } });
socket.on('session-ready', async packet => {
  if (packet.startedAt) startSyncedTimer(packet.startedAt);
  if (state.match?.videoProvider === 'daily') { const status = root.querySelector('#daily-status'); if (status) { status.textContent = 'Both participants are here. Your session has started.'; status.classList.add('ready'); } return; }
  if (!state.pc) return;
  if (state.match?.startsAsInterviewer && !state.offerStarted) { state.offerStarted = true; const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer); socket.emit('signal', { roomId: state.roomId, data: { offer } }); }
  updateConnection('Partner joined — establishing secure connection…', false);
});
socket.on('signal', handleSignal);
socket.on('workspace-state', workspace => {
  state.workspace = workspace || state.workspace; const editor = root.querySelector('#shared-code'), language = root.querySelector('#code-language');
  if (editor && document.activeElement !== editor) editor.value = state.workspace.code || ''; if (language) language.value = state.workspace.language || 'JavaScript';
  const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Synced with your partner';
});
socket.on('workspace-update', workspace => { state.workspace = workspace; const editor = root.querySelector('#shared-code'); if (editor && document.activeElement !== editor) editor.value = workspace.code; const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Partner updated the workspace'; });
socket.on('chat-state', messages => { state.chat = messages || []; renderChat(); });
socket.on('chat-message', message => { state.chat.push(message); renderChat(); });
socket.on('peer-left', () => updateConnection('Your partner left the room. They can rejoin.', false));
socket.on('session-ended', () => { endLocalCall(); go('feedback'); });
socket.on('peer-feedback-submitted', () => {
  const button = root.querySelector('#submit');
  if (button?.disabled) button.textContent = 'Partner submitted — finalizing feedback…';
  else toast('Your partner has submitted feedback. Complete yours when ready.');
});
socket.on('feedback-ready', feedbackData => {
  state.feedback = feedbackData;
  localStorage.removeItem('mocksyra-active-match');
  socket.emit('restore-profile');
  go('dashboard');
});
socket.on('app-error', message => toast(message));
socket.on('connect_error', error => { if (error.message === 'Authentication required') { localStorage.removeItem(EMAIL_KEY); if (location.hash !== '#home') go('auth'); } });

async function logout() {
  endLocalCall(); socket.disconnect(); await window.peerSupabase.auth.signOut();
  localStorage.removeItem(EMAIL_KEY); localStorage.removeItem(PROFILE_KEY); localStorage.removeItem('mocksyra-active-match');
  state.profile = null; state.authUser = null; state.match = null; state.history = []; state.notifications = []; go('home'); toast('You have been logged out.');
}
document.addEventListener('click', event => { if (event.target.closest('#logout')) logout(); });

function router() {
  const route = location.hash.slice(1) || 'home';
  if (route === 'auth') return window.renderAuthPage();
  const protectedRoutes = ['onboarding', 'marketplace', 'search', 'match', 'session', 'feedback', 'dashboard', 'activity'];
  if (protectedRoutes.includes(route) && !localStorage.getItem(EMAIL_KEY)) return window.renderAuthPage();
  const active = readJson('mocksyra-active-match', null);
  if (!state.match && active) { state.match = active; state.roomId = active.roomId; }
  const routes = { onboarding, marketplace, search, match, session, feedback, dashboard, activity };
  (routes[route] || home)();
  if (localStorage.getItem(EMAIL_KEY)) connectSocket();
}
window.navigateMocksyra = route => { if (location.hash === `#${route}`) router(); else go(route); };

window.addEventListener('hashchange', router);
async function restoreAuthentication() {
  try {
    const { data } = await window.peerSupabase.auth.getSession();
    const user = data.session?.user;
    if (user?.email) {
      state.authUser = user;
      state.authenticated = true;
      localStorage.setItem(EMAIL_KEY, user.email);
      if (location.hash === '#auth') go('marketplace');
      else router();
    }
  } catch {
    /* Keep the current view usable if Supabase is temporarily unavailable. */
  }
}
router();
restoreAuthentication();
