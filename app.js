const root = document.querySelector('#app');
const socket = io((['localhost', '127.0.0.1'].includes(location.hostname) ? location.origin : window.MOCKSYRA_SOCKET_URL) || location.origin, {
  autoConnect: false,
  timeout: 90000
});

const PROFILE_KEY = 'mocksyra-profile';
const EMAIL_KEY = 'mocksyra-email';
const ACTIVE_MATCH_KEY = 'mocksyra-active-match';
const ACTIVE_MATCHES_KEY = 'mocksyra-active-matches';
const ACCOUNT_KEY = 'mocksyra-account-key';
const MAX_UPCOMING_MATCHES = 4;
const skills = window.MOCKSYRA_SITE?.technologies || ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'React', 'Node.js', 'Spring Boot', 'SQL', 'AWS'];
const interviewTypes = ['Data Structures & Algorithms', 'Frontend', 'Backend', 'System Design', 'Behavioral', 'SQL'];

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
};
const initialAuthUser = window.__mocksyraAuthUser || null;
const initialAuthKey = initialAuthUser?.email ? `${initialAuthUser.id || 'email'}:${String(initialAuthUser.email).toLowerCase()}` : '';
const initialStoredKey = localStorage.getItem(ACCOUNT_KEY) || '';
const initialProfileEmail = String(readJson(PROFILE_KEY, null)?.email || '').toLowerCase();
const previousAccountEmail = String(window.__mocksyraPreviousAccountEmail || '').toLowerCase();
if (initialAuthKey && ((initialStoredKey && initialStoredKey !== initialAuthKey) || (initialProfileEmail && initialProfileEmail !== String(initialAuthUser.email).toLowerCase()) || (previousAccountEmail && previousAccountEmail !== String(initialAuthUser.email).toLowerCase()))) {
  [PROFILE_KEY, ACTIVE_MATCH_KEY, ACTIVE_MATCHES_KEY].forEach(key => localStorage.removeItem(key));
}
delete window.__mocksyraPreviousAccountEmail;

const state = {
  profile: readJson(PROFILE_KEY, null),
  authUser: initialAuthUser,
  activeMatches: readJson(ACTIVE_MATCHES_KEY, []),
  ownListings: [],
  match: readJson(ACTIVE_MATCH_KEY, null),
  roomId: readJson(ACTIVE_MATCH_KEY, null)?.roomId || null,
  notifications: [],
  history: [],
  listings: [],
  serverNow: null,
  dailyCall: null,
  dailyPreparation: 0,
  liveRoomId: null,
  callGeneration: 0,
  workspace: { code: '', language: 'JavaScript', version: 0 },
  chat: [],
  selectedMode: sessionStorage.getItem('mocksyra-mode') || null,
  activeRoute: '',
  authenticated: Boolean(localStorage.getItem(EMAIL_KEY)),
  authResolved: Boolean(window.__mocksyraAuthUser),
  restored: false
};
if (!Array.isArray(state.activeMatches)) state.activeMatches = [];

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
const titleCaseEmailName = email => String(email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()).trim();
const safeAvatarUrl = value => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
};
const accountIdentity = () => {
  const user = state.authUser || {};
  const metadata = user.user_metadata || {};
  const google = (user.identities || []).find(identity => identity?.provider === 'google')?.identity_data || {};
  const email = user.email || google.email || metadata.email || localStorage.getItem(EMAIL_KEY) || '';
  const name = google.full_name || google.name || metadata.full_name || metadata.name || titleCaseEmailName(email) || 'Your account';
  const avatarUrl = safeAvatarUrl(google.avatar_url || google.picture || metadata.avatar_url || metadata.picture);
  return { name, email, avatarUrl, initials: name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'Y' };
};
const authUserKey = user => user?.email ? `${user.id || 'email'}:${String(user.email).toLowerCase()}` : '';
const bookingDisplayName = () => state.profile?.name || accountIdentity().name;
const modeFor = () => modes[normalizedMode(state.match?.practiceMode || state.profile?.practiceMode)];
const sessionMinutes = () => Number(state.match?.durationMinutes) || 45;
const closedMatch = match => !match || ['completed', 'cancelled', 'expired'].includes(match.status);
if (state.match && !closedMatch(state.match) && !state.activeMatches.some(item => item.roomId === state.match.roomId)) {
  state.activeMatches.push(state.match);
  localStorage.setItem(ACTIVE_MATCHES_KEY, JSON.stringify(state.activeMatches));
}
const confirmedMatches = () => state.activeMatches.filter(matchData => !closedMatch(matchData) && ['matched', 'in_progress'].includes(matchData.status));
const persistMatches = () => localStorage.setItem(ACTIVE_MATCHES_KEY, JSON.stringify(state.activeMatches));
const selectMatch = matchData => {
  if (!matchData) return;
  if (state.roomId !== matchData.roomId) {
    endLocalCall();
    state.workspace = { code: '', language: matchData.peer?.languages?.[0] || 'JavaScript', version: 0 };
    state.chat = [];
  }
  state.match = matchData;
  state.roomId = matchData.roomId;
  localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(matchData));
};
const upsertMatch = matchData => {
  if (!matchData?.roomId) return;
  const index = state.activeMatches.findIndex(item => item.roomId === matchData.roomId);
  if (index === -1) state.activeMatches.push(matchData);
  else state.activeMatches[index] = { ...state.activeMatches[index], ...matchData };
  state.activeMatches = state.activeMatches.filter(item => !closedMatch(item)).sort((a, b) => Date.parse(a.sharedSlot) - Date.parse(b.sharedSlot));
  persistMatches();
};
const applyScheduleResponse = response => {
  if (!response) return;
  const returnedMatches = Array.isArray(response.activeMatches) ? response.activeMatches : Array.isArray(response.upcomingMatches) ? response.upcomingMatches : null;
  if (returnedMatches) {
    state.activeMatches = returnedMatches.filter(item => !closedMatch(item)).sort((a, b) => Date.parse(a.sharedSlot) - Date.parse(b.sharedSlot));
    persistMatches();
  } else if (response.activeMatch) upsertMatch(response.activeMatch);
  if (Array.isArray(response.ownListings)) state.ownListings = response.ownListings;
};
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
  const account = accountIdentity();
  const unread = state.notifications.filter(item => !item.read).length;
  return `<div class="app-shell">
    <header class="app-nav"><div class="shell app-nav-main">
      <a class="brand" href="#home"><i>◒</i> Mocksyra</a>
      <nav class="app-sections" aria-label="Main"><button class="text-button" data-route="marketplace">Sessions</button><button class="nav-activity" data-route="activity">History${unread ? `<span>${unread}</span>` : ''}</button></nav>
      <nav class="profile-menu" aria-label="Account">
        <span class="account-avatar">${account.avatarUrl ? `<img src="${escapeHtml(account.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : ''}<span aria-hidden="true">${escapeHtml(account.initials)}</span></span>
        <span class="account-copy"><b class="account-name">${escapeHtml(account.name)}</b>${account.email ? `<small class="account-email">${escapeHtml(account.email)}</small>` : ''}</span><button class="text-button" id="logout">Log out</button>
      </nav>
    </div></header><main class="app-main"><div class="shell">${content}</div></main></div>`;
}
function bindRoutes(scope = root) {
  scope.querySelectorAll('.account-avatar img').forEach(image => { image.onerror = () => { image.hidden = true; }; });
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
function updateAccountHeader() {
  const menu = root.querySelector('.profile-menu');
  if (!menu) return;
  const account = accountIdentity();
  const name = menu.querySelector('.account-name'), email = menu.querySelector('.account-email'), avatar = menu.querySelector('.account-avatar');
  if (name) name.textContent = account.name;
  if (email) email.textContent = account.email;
  if (!avatar) return;
  const initials = avatar.querySelector('span');
  if (initials) initials.textContent = account.initials;
  let image = avatar.querySelector('img');
  if (!account.avatarUrl) { image?.remove(); return; }
  if (!image) {
    image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    avatar.prepend(image);
  }
  image.hidden = false;
  image.onerror = () => { image.hidden = true; };
  image.src = account.avatarUrl;
}

let connectionPromise;
let connectionPromiseKey = '';
let connectionAttempt = 0;
let connectedAuthKey = '';
let cancelConnectionWait = null;
let logoutInProgress = false;
let authRecoveryPromise = null;
let authRecoveryRetryToken = '';
function cancelSocketConnection() {
  connectionAttempt += 1;
  const cancelPending = cancelConnectionWait;
  cancelConnectionWait = null;
  if (cancelPending) cancelPending();
  const wasConnecting = Boolean(connectionPromise);
  connectionPromise = null;
  connectionPromiseKey = '';
  connectedAuthKey = '';
  socket.auth = {};
  if (socket.connected || socket.active || wasConnecting) socket.disconnect();
}
function clearSupabaseStoredSession() {
  const storageKey = window.peerSupabase?.auth?.storageKey || 'sb-qjghjsapizkqktcbczgj-auth-token';
  for (const key of [...Array(localStorage.length)].map((_, index) => localStorage.key(index)).filter(Boolean)) {
    if (key === storageKey || key.startsWith(`${storageKey}.`)) localStorage.removeItem(key);
  }
}
function invalidateAuthentication(message = 'Your session has expired. Please sign in again.') {
  authRecoveryRetryToken = '';
  clearSupabaseStoredSession();
  window.__mocksyraAuthUser = null;
  window.__mocksyraAccessToken = '';
  applyAuthenticatedUser(null, 'AUTH_FAILURE');
  toast(message);
}
function invalidRefreshError(error) {
  const status = Number(error?.status || error?.statusCode);
  const message = String(error?.message || error || '').toLowerCase();
  return [400, 401, 403].includes(status) || /invalid.*refresh|refresh.*token.*(?:missing|expired|invalid)|session.*(?:missing|expired|invalid)/.test(message);
}
function recoverSocketAuthentication() {
  const expectedAuthKey = authUserKey(state.authUser);
  const rejectedToken = String(socket.auth?.accessToken || window.__mocksyraAccessToken || '');
  if (!expectedAuthKey) {
    invalidateAuthentication();
    return Promise.resolve(false);
  }
  if (authRecoveryRetryToken && rejectedToken === authRecoveryRetryToken) {
    invalidateAuthentication('We could not verify the refreshed session. Please sign in again.');
    return Promise.resolve(false);
  }
  if (authRecoveryPromise) return authRecoveryPromise;

  const task = Promise.resolve().then(async () => {
    cancelSocketConnection();
    let result;
    try {
      result = await window.peerSupabase.auth.refreshSession();
    } catch (error) {
      result = { data: { session: null }, error };
    }
    if (authUserKey(state.authUser) !== expectedAuthKey) return false;
    const session = result?.data?.session;
    const refreshedToken = String(session?.access_token || '');
    if (result?.error && !invalidRefreshError(result.error)) {
      toast('We could not refresh your session. Check your connection and retry.');
      return false;
    }
    if (result?.error || !session?.user || authUserKey(session.user) !== expectedAuthKey || !refreshedToken || refreshedToken === rejectedToken) {
      invalidateAuthentication();
      return false;
    }
    window.__mocksyraAuthUser = session.user;
    window.__mocksyraAccessToken = refreshedToken;
    socket.auth = { accessToken: refreshedToken };
    applyAuthenticatedUser(session.user, 'TOKEN_REFRESHED');
    if (authUserKey(state.authUser) !== expectedAuthKey) return false;
    authRecoveryRetryToken = refreshedToken;
    if (routeName() === 'auth') go('marketplace');
    const connected = await connectSocket();
    if (connected) authRecoveryRetryToken = '';
    else if (authUserKey(state.authUser) === expectedAuthKey) authRecoveryRetryToken = '';
    return connected;
  });
  authRecoveryPromise = task;
  task.then(() => { if (authRecoveryPromise === task) authRecoveryPromise = null; }, () => { if (authRecoveryPromise === task) authRecoveryPromise = null; });
  return task;
}
function connectSocket() {
  const expectedAuthKey = authUserKey(state.authUser);
  if (!expectedAuthKey) return Promise.resolve(false);
  if (socket.connected && connectedAuthKey === expectedAuthKey) return Promise.resolve(true);
  if (connectionPromise && connectionPromiseKey === expectedAuthKey) return connectionPromise;
  if (connectionPromise || socket.connected || socket.active) cancelSocketConnection();

  const attempt = ++connectionAttempt;
  connectionPromiseKey = expectedAuthKey;
  const task = (async () => {
    let data;
    try {
      ({ data } = await window.peerSupabase.auth.getSession());
    } catch {
      if (attempt === connectionAttempt) toast('Could not verify your account. Please sign in again.');
      return false;
    }
    const session = data?.session;
    const sessionAuthKey = authUserKey(session?.user);
    if (attempt !== connectionAttempt || sessionAuthKey !== expectedAuthKey || authUserKey(state.authUser) !== expectedAuthKey) return false;
    socket.auth = { accessToken: session.access_token };
    // Keep the verified identity authorized while Socket.IO performs its own
    // transient reconnects. Account changes explicitly clear this key.
    connectedAuthKey = expectedAuthKey;
    return new Promise(resolve => {
      let settled = false;
      const finish = success => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('connect', onConnect); socket.off('connect_error', onError);
        if (cancelConnectionWait === cancel) cancelConnectionWait = null;
        if (success && attempt === connectionAttempt && authUserKey(state.authUser) === expectedAuthKey) connectedAuthKey = expectedAuthKey;
        resolve(success && attempt === connectionAttempt && authUserKey(state.authUser) === expectedAuthKey);
      };
      const cancel = () => finish(false);
      const onConnect = () => finish(true);
      const onError = error => {
        if (error.message === 'Authentication required' || !socket.active) return finish(false);
        // A sleeping hosted service can reject the first transport while it is
        // waking up. Socket.IO will retry automatically, so keep this promise
        // pending and let callers wait for the recovered connection.
        if (attempt === connectionAttempt) toast('Connecting to the interview server… This can take a moment the first time.');
      };
      const timeout = setTimeout(() => {
        if (attempt === connectionAttempt) toast('The server is taking a little longer. Please retry.');
        finish(false);
      }, 95000);
      cancelConnectionWait = cancel;
      socket.once('connect', onConnect); socket.once('connect_error', onError); socket.connect();
    });
  })();
  connectionPromise = task;
  task.then(() => {
    if (connectionPromise === task) {
      connectionPromise = null;
      connectionPromiseKey = '';
    }
  });
  return task;
}
window.connectMocksyraSocket = connectSocket;
function request(event, payload, timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!socket.connected) return resolve({ ok: false, error: 'You are offline. Please reconnect and try again.' });
    const requestAttempt = connectionAttempt;
    const requestAuthKey = connectedAuthKey;
    const requestSocketId = socket.id;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stale = requestAttempt !== connectionAttempt || requestAuthKey !== connectedAuthKey || requestAuthKey !== authUserKey(state.authUser) || !socket.connected || socket.id !== requestSocketId;
      resolve(stale ? { ok: false, stale: true, error: 'Your account changed before this request finished.' } : result || { ok: true });
    };
    const timeout = setTimeout(() => finish({ ok: false, error: 'No response yet. Please try again.' }), timeoutMs);
    socket.emit(event, payload, finish);
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

const padDatePart = value => String(value).padStart(2, '0');
const localDateValue = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
};
const localTimeValue = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
};
const defaultAvailability = () => {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 30) * 30, 0, 0);
  return date;
};
const availabilityIso = (dateValue, timeValue) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return '';
  const date = new Date(`${dateValue}T${timeValue}:00`);
  if (Number.isNaN(date.getTime()) || localDateValue(date) !== dateValue || localTimeValue(date) !== timeValue) return '';
  return date.toISOString();
};

function onboarding() {
  const previous = state.profile || {};
  let selectedMode = normalizedMode(state.selectedMode || previous.practiceMode);
  const previousSlot = (previous.slots || []).find(value => Date.parse(value) > Date.now());
  const selectedAvailability = previousSlot ? new Date(previousSlot) : defaultAvailability();
  const minimumDate = localDateValue(new Date());
  const maximumDate = new Date(); maximumDate.setDate(maximumDate.getDate() + 90);
  let selectedTechnology = previous.languages?.[0] || skills[0];
  const upcomingCount = confirmedMatches().length;
  root.innerHTML = frame(`<section class="simple-page onboarding-page">
    <header class="simple-page-heading"><p class="eyebrow">SET UP AN INTERVIEW</p><h1 class="page-title">Choose your role and time.</h1>
    <p class="page-subtitle">Every interview has one candidate and one interviewer. Sessions last 45 minutes.</p></header>
    ${upcomingCount ? `<div class="notice">You have ${upcomingCount} upcoming interview${upcomingCount === 1 ? '' : 's'}. You can add another non-overlapping time${upcomingCount >= MAX_UPCOMING_MATCHES ? ' after one is completed or cancelled' : ''}.</div>` : ''}
    <form id="preferences-form" class="panel onboarding-form clean-form">
      <fieldset class="role-fieldset"><legend class="field-label">I want to join as</legend><div class="role-selector" role="group" aria-label="Interview role">
        ${['candidate', 'interviewer'].map(key => `<button type="button" class="role-option ${selectedMode === key ? 'selected' : ''}" data-mode="${key}" aria-pressed="${selectedMode === key}">${icon(modes[key].icon)}<span><b>${modes[key].title}</b><small>${modes[key].description}</small></span></button>`).join('')}
      </div></fieldset><p class="role-help" id="role-help"></p>
      <div class="simple-form-grid">
        <div><label class="field-label" for="name">Name shown to interview partners</label><input id="name" class="textarea input" maxlength="40" required autocomplete="nickname" value="${escapeHtml(previous.name || bookingDisplayName())}" placeholder="Your name"></div>
        <div><label class="field-label" for="interview-type">Interview focus</label><select id="interview-type" class="select">${interviewTypes.map(value => `<option ${value === previous.interviewType ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div>
        <div><label class="field-label" for="technology">Technology</label><select id="technology" class="select">${skills.map(value => `<option ${value === selectedTechnology ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div>
        <div class="availability-block"><span class="field-label">Available date and time</span><div class="availability-fields">
          <label class="availability-field"><span>Date</span><input id="session-date" class="textarea input" type="date" min="${minimumDate}" max="${localDateValue(maximumDate)}" value="${localDateValue(selectedAvailability)}" required></label>
          <label class="availability-field"><span>Start time</span><input id="session-time" class="textarea input" type="time" step="900" value="${localTimeValue(selectedAvailability)}" required></label>
        </div><small class="input-help">Your timezone: ${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}</small></div>
      </div>
      <p id="preference-error" class="form-error" role="alert"></p>
      <div class="clean-form-actions"><span>Free · 45 minutes · Live video</span><button type="submit" class="button" id="publish" ${upcomingCount >= MAX_UPCOMING_MATCHES ? 'disabled' : ''}><span id="publish-label"></span></button></div>
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
    selectedTechnology = root.querySelector('#technology').value;
    const selectedSlot = availabilityIso(root.querySelector('#session-date').value, root.querySelector('#session-time').value);
    if (!name || !selectedTechnology || !selectedSlot) { error.textContent = 'Add your name, technology, and available time.'; return; }
    if (Date.parse(selectedSlot) <= Date.now()) { error.textContent = 'Choose a date and time in the future.'; return; }
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
    applyScheduleResponse(result);
    if (result.profile) { state.profile = { ...state.profile, ...result.profile }; localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); }
    if (result.serverNow) state.serverNow = result.serverNow;
    if (result.activeMatch) selectMatch(result.activeMatch);
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
    if (results) {
      results.setAttribute('aria-busy', 'false');
      results.innerHTML = '<p class="empty-state" role="alert">Could not reach the session marketplace. Please try again.</p>';
    }
    return;
  }
  const response = await request('browse-listings', {});
  if (!response.ok) {
    if (results) {
      results.setAttribute('aria-busy', 'false');
      results.innerHTML = `<p class="empty-state" role="alert">${escapeHtml(response.error)}</p>`;
    }
    return;
  }
  state.listings = response.listings || [];
  applyScheduleResponse(response);
  state.serverNow = response.serverNow || state.serverNow;
  renderYourSchedule();
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
  const scheduleFull = confirmedMatches().length >= MAX_UPCOMING_MATCHES;
  results.innerHTML = sessions.map(listing => {
    const requiredRole = listing.requiredRole || (listing.practiceMode === 'candidate' ? 'interviewer' : 'candidate');
    const offer = listing.practiceMode === 'interviewer' ? 'Interviewer available' : 'Candidate looking for an interviewer';
    return `<article class="session-card" role="listitem" data-listing-id="${escapeHtml(listing.listingId)}">
    <header class="session-card-person"><span class="listing-avatar">${escapeHtml(listing.name?.[0] || '?')}</span><div><span class="session-role">${offer}</span><h2>${escapeHtml(listing.name)}</h2><p>${escapeHtml(listing.experience)} · ${escapeHtml(listing.spokenLanguage)}</p></div></header>
    <div class="session-card-main"><div><h3>${escapeHtml(listing.interviewType)}</h3><p>${escapeHtml((listing.languages || []).slice(0, 3).join(' · '))}</p></div><div class="session-card-time"><time datetime="${escapeHtml(listing.slot)}">${escapeHtml(formatSlot(listing.slot))}</time><span>45 minutes</span></div></div>
    <div class="session-card-actions"><button class="button" data-book-listing="${escapeHtml(listing.listingId)}" data-book-role="${requiredRole}" data-slot="${escapeHtml(listing.slot)}" aria-label="Book with ${escapeHtml(listing.name)} as ${requiredRole}" ${scheduleFull ? 'disabled' : ''}>${scheduleFull ? 'Schedule full' : `Book as ${modes[requiredRole].title}`}</button></div><p class="session-card-error" role="alert"></p>
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
    name: bookingDisplayName(),
    practiceMode: role,
    languages: state.profile?.languages?.length ? state.profile.languages : listing.languages,
    slots: [button.dataset.slot],
    interviewType: listing.interviewType,
    experience: state.profile?.experience || 'Beginner',
    spokenLanguage: state.profile?.spokenLanguage || listing.spokenLanguage || 'English',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  const previousRoomIds = new Set(state.activeMatches.map(item => item.roomId));
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Reserving…'; error.textContent = '';
  const response = await request('book-listing', { listingId: button.dataset.bookListing, slot: button.dataset.slot, profile: bookingProfile });
  if (!response.ok) {
    error.textContent = response.error; button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = `Book as ${modes[role].title}`;
    await refreshMarketplace(false); return;
  }
  state.profile = { ...bookingProfile, ...(response.profile || {}) };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
  saveProfileToSupabase(state.profile);
  applyScheduleResponse(response);
  const newMatch = state.activeMatches.find(item => !previousRoomIds.has(item.roomId)) || state.activeMatches.find(item => item.listingId === button.dataset.bookListing);
  if ((!state.match || closedMatch(state.match)) && (newMatch || response.activeMatch)) selectMatch(newMatch || response.activeMatch);
  toast('Interview booked. It is now in your schedule.');
  await refreshMarketplace(false);
}

function renderYourSchedule() {
  const upcoming = root.querySelector('#upcoming-schedule');
  const offers = root.querySelector('#open-offers');
  const summary = root.querySelector('#schedule-summary');
  if (!upcoming || !offers) return;
  const matches = state.activeMatches.filter(item => !closedMatch(item)).sort((a, b) => Date.parse(a.sharedSlot) - Date.parse(b.sharedSlot));
  const listings = state.ownListings.flatMap(listing => {
    const slots = listing.slots?.length ? listing.slots : listing.slot ? [listing.slot] : [];
    return slots.map(slot => ({ ...listing, slot }));
  }).sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
  if (summary) summary.textContent = `${matches.length} upcoming · ${listings.length} open ${listings.length === 1 ? 'time' : 'times'}`;
  upcoming.innerHTML = matches.length ? matches.map(matchData => {
    const role = modes[normalizedMode(matchData.practiceMode)].title;
    const joinState = scheduledJoinState(matchData);
    const action = matchData.status === 'feedback_pending' ? 'Complete feedback' : joinState.allowed ? 'Join now' : 'View booking';
    return `<article class="schedule-card" data-room-id="${escapeHtml(matchData.roomId)}">
      <div class="schedule-card-main"><div class="schedule-card-copy"><span class="match-badge">${escapeHtml(role)}</span><h3>${escapeHtml(matchData.interviewType)} with ${escapeHtml(matchData.peer?.name || 'your partner')}</h3><p>${escapeHtml((matchData.languages || []).join(' · ') || matchData.peer?.languages?.join(' · ') || 'Interview session')}</p></div><div class="schedule-card-meta"><time datetime="${escapeHtml(matchData.sharedSlot)}">${escapeHtml(formatSlot(matchData.sharedSlot))}</time><span>${Number(matchData.durationMinutes) || 45} minutes</span></div></div>
      <div class="schedule-card-actions"><button class="button" data-open-match="${escapeHtml(matchData.roomId)}">${action}</button>${matchData.status === 'matched' ? `<button class="text-button" data-cancel-match="${escapeHtml(matchData.roomId)}">Cancel interview</button>` : ''}</div>
    </article>`;
  }).join('') : '<p class="schedule-empty">No upcoming interviews yet.</p>';
  offers.innerHTML = listings.length ? listings.map(listing => `<article class="schedule-card" data-own-listing-id="${escapeHtml(listing.listingId)}">
    <div class="schedule-card-main"><div class="schedule-card-copy"><span class="match-badge">Offering as ${escapeHtml(modes[normalizedMode(listing.practiceMode)].title)}</span><h3>${escapeHtml(listing.interviewType)}</h3><p>${escapeHtml((listing.languages || []).join(' · ') || 'Interview session')}</p></div><div class="schedule-card-meta"><time datetime="${escapeHtml(listing.slot)}">${escapeHtml(formatSlot(listing.slot))}</time><span>45 minutes</span></div></div>
    <div class="schedule-card-actions"><button class="text-button" data-cancel-listing="${escapeHtml(listing.listingId)}">Cancel offer</button></div>
  </article>`).join('') : '<p class="schedule-empty">You have no open times. Add one whenever you are ready.</p>';
  upcoming.querySelectorAll('[data-open-match]').forEach(button => button.onclick = () => {
    const selected = state.activeMatches.find(item => item.roomId === button.dataset.openMatch);
    if (selected) { selectMatch(selected); go(selected.status === 'feedback_pending' ? 'feedback' : 'match'); }
  });
  upcoming.querySelectorAll('[data-cancel-match]').forEach(button => button.onclick = () => cancelScheduledMatch(button));
  offers.querySelectorAll('[data-cancel-listing]').forEach(button => button.onclick = () => cancelOwnListing(button));
}

async function cancelScheduledMatch(button) {
  const roomId = button.dataset.cancelMatch;
  if (!roomId || !confirm('Cancel this interview for both participants?')) return;
  button.disabled = true; button.textContent = 'Cancelling…';
  const response = await request('cancel-match', roomId);
  if (!response.ok) { button.disabled = false; button.textContent = 'Cancel interview'; return toast(response.error); }
  applyScheduleResponse(response);
  clearActiveMatch(roomId);
  toast('Interview cancelled.');
  await refreshMarketplace(false);
}

async function cancelOwnListing(button) {
  const listingId = button.dataset.cancelListing;
  if (!listingId) return;
  button.disabled = true; button.textContent = 'Cancelling…';
  const response = await request('cancel-listing', { listingId });
  if (!response.ok) { button.disabled = false; button.textContent = 'Cancel offer'; return toast(response.error); }
  applyScheduleResponse(response);
  if (!Array.isArray(response.ownListings)) state.ownListings = state.ownListings.filter(item => item.listingId !== listingId);
  toast('Offer cancelled.');
  await refreshMarketplace(false);
}

function marketplace() {
  root.innerHTML = frame(`<section class="marketplace-page sessions-board" aria-labelledby="marketplace-title">
    <header class="marketplace-heading"><div><h1 class="page-title" id="marketplace-title" tabindex="-1">Interview sessions</h1><p class="page-subtitle">Book an open time or add your own availability.</p></div><button class="button" data-create-role="candidate">Create a session</button></header>
    <section class="your-schedule" aria-labelledby="your-schedule-title"><div class="schedule-heading"><div><h2 id="your-schedule-title">Your schedule</h2><p id="schedule-summary">Loading your bookings and open times…</p></div></div>
      <section class="schedule-section" aria-labelledby="upcoming-title"><h3 class="schedule-section-heading" id="upcoming-title">Upcoming interviews</h3><div class="schedule-list" id="upcoming-schedule"></div></section>
      <section class="schedule-section" aria-labelledby="offers-title"><h3 class="schedule-section-heading" id="offers-title">Your open times</h3><div class="schedule-list" id="open-offers"></div></section>
    </section>
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
  renderYourSchedule();
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
  const prefix = sameDay(today) ? 'Today' : sameDay(tomorrow) ? 'Tomorrow' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return `${prefix} · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

async function ensureMedia() {
  if (state.stream?.active) return true;
  const generation = state.callGeneration;
  const useStream = stream => {
    if (generation !== state.callGeneration) {
      stream?.getTracks().forEach(track => track.stop());
      return false;
    }
    state.stream = stream;
    return true;
  };
  try { return useStream(await navigator.mediaDevices.getUserMedia({ video: true, audio: true })); }
  catch {
    if (generation !== state.callGeneration) return false;
    try {
      const ready = useStream(await navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
      if (ready) toast('Camera unavailable. Audio-only mode is ready.');
      return ready;
    }
    catch { if (generation === state.callGeneration) toast('Allow microphone access in your browser before joining.'); return false; }
  }
}

async function deviceCheck() {
  const status = root.querySelector('#device-status');
  status.textContent = 'Requesting permission…';
  const ready = await ensureMedia();
  if (!status.isConnected) return;
  if (!ready) { status.textContent = 'Microphone and camera unavailable'; status.className = 'device-status error'; return; }
  const preview = root.querySelector('#device-preview');
  if (!preview) return;
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
    clearActiveMatch(state.roomId); go('marketplace');
  });
  root.querySelector('#join').onclick = async () => {
    if (feedbackPending) return go('feedback');
    const roomId = state.roomId, matchData = state.match, generation = state.callGeneration;
    const isCurrent = () => routeName() === 'match' && state.roomId === roomId && state.match === matchData && state.callGeneration === generation;
    if (!(await connectSocket())) return;
    if (!isCurrent()) return;
    if (matchData.videoProvider === 'daily') { endLocalCall(); return go('session'); }
    const prepared = await request('prepare-call', { roomId });
    if (!isCurrent()) return;
    if (!prepared.ok) return toast(prepared.error);
    if (await ensureMedia() && isCurrent()) go('session');
  };
  clearInterval(state.joinClock);
  if (!feedbackPending) state.joinClock = setInterval(() => {
    const next = scheduledJoinState(state.match), button = root.querySelector('#join'), status = root.querySelector('#join-status');
    if (!button || !status) return clearInterval(state.joinClock);
    button.disabled = !next.allowed; button.textContent = next.allowed ? 'Join interview' : 'Room not open yet'; status.textContent = next.message;
  }, 30_000);
}

function calendarDate(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function calendarText(value) { return String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function foldCalendarLine(line) {
  const characters = [...String(line)];
  const rows = [];
  while (characters.length) rows.push(`${rows.length ? ' ' : ''}${characters.splice(0, rows.length ? 73 : 74).join('')}`);
  return rows.join('\r\n');
}
function downloadCalendar() {
  if (!state.match?.sharedSlot) return toast('No scheduled time is available.');
  const start = new Date(state.match.sharedSlot), end = new Date(start.getTime() + sessionMinutes() * 60 * 1000);
  const url = `${location.origin}${location.pathname}#match?room=${encodeURIComponent(state.roomId)}`;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mocksyra//Interview//EN', 'BEGIN:VEVENT',
    `UID:${state.roomId}@mocksyra`, `DTSTAMP:${calendarDate(new Date())}`, `DTSTART:${calendarDate(start)}`, `DTEND:${calendarDate(end)}`,
    `SUMMARY:Mocksyra interview with ${calendarText(state.match.peer.name)}`, `DESCRIPTION:Open Mocksyra to join your interview: ${calendarText(url)}`, `URL:${calendarText(url)}`, 'END:VEVENT', 'END:VCALENDAR'].map(foldCalendarLine).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); link.download = 'mocksyra-interview.ics'; link.click(); URL.revokeObjectURL(link.href);
}

function session() {
  const dailySession = state.match?.videoProvider === 'daily';
  if (!state.match || (!dailySession && !state.stream?.active)) return go('match');
  const roomId = state.roomId;
  const peer = state.match.peer, question = state.match.question || {};
  const minutes = sessionMinutes(), initialTimer = `${minutes}:00`;
  const videoSurface = dailySession ? `<div class="call-stage daily-call-stage tool-panel" id="video-panel"><div class="call-top"><span class="live">● HOSTED VIDEO</span><span id="timer">${initialTimer}</span></div><div class="daily-status" id="daily-status"><span class="daily-status-message" role="status" aria-live="polite">Preparing your private video room…</span></div><div class="daily-container" id="daily-container"></div><div class="daily-finish"><button class="call-action end" id="complete"><b>×</b><span>Finish interview</span></button></div></div>` : `<div class="call-stage tool-panel" id="video-panel"><div class="call-top"><span class="live">● LIVE SESSION</span><span id="timer">${initialTimer}</span></div>
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
  root.querySelector('#complete').onclick = event => { if (confirm('Finish the interview for both participants and open feedback?')) finishCurrentSession(roomId, event.currentTarget); };
}

async function joinCurrentCallRoom(roomId, generation) {
  const connectionId = socket.id;
  const wasAlreadyLive = state.liveRoomId === roomId;
  const joined = await request('join-session', roomId);
  const sameConnection = socket.connected && socket.id === connectionId;
  const stillCurrent = state.roomId === roomId && state.callGeneration === generation && routeName() === 'session';
  if (!sameConnection || !stillCurrent) {
    if (joined.ok && !joined.stale && sameConnection && (!wasAlreadyLive || state.liveRoomId === roomId)) socket.emit('leave-session', roomId);
    return { ...joined, staleCall: true };
  }
  if (!joined.ok) {
    if (!joined.stale) socket.emit('leave-session', roomId);
    return joined;
  }
  state.liveRoomId = roomId;
  return joined;
}

async function disposeDailyCall(call, timeoutMs = 1200) {
  if (!call) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => call.leave()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    try { call.destroy(); } catch {}
  }
}

function setDailyStatus(status, message, tone = '') {
  if (!status) return;
  status.className = `daily-status${tone ? ` ${tone}` : ''}`;
  const copy = document.createElement('span');
  copy.className = 'daily-status-message';
  copy.setAttribute('role', 'status'); copy.setAttribute('aria-live', 'polite');
  copy.textContent = message;
  status.replaceChildren(copy);
}

async function prepareDailyCall() {
  const roomId = state.roomId, generation = state.callGeneration, attempt = ++state.dailyPreparation;
  const status = root.querySelector('#daily-status'), container = root.querySelector('#daily-container');
  const sameSession = () => generation === state.callGeneration && state.roomId === roomId && routeName() === 'session' && status?.isConnected && container?.isConnected;
  const isCurrent = call => attempt === state.dailyPreparation && sameSession() && (!call || state.dailyCall === call);
  const releaseLiveMembership = () => {
    if (state.liveRoomId !== roomId) return;
    state.liveRoomId = null;
    if (socket.connected) socket.emit('leave-session', roomId);
  };
  let failed = false;
  if (!window.DailyIframe) { setDailyStatus(status, 'The hosted video component could not load. Check your connection and refresh.', 'error'); return; }
  const showRetry = message => {
    if (!isCurrent()) return;
    failed = true;
    releaseLiveMembership();
    setDailyStatus(status, message, 'error');
    const actions = document.createElement('span'); actions.className = 'daily-status-actions';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'daily-retry'; retry.textContent = 'Retry video';
    const schedule = document.createElement('button'); schedule.type = 'button'; schedule.className = 'daily-retry secondary'; schedule.textContent = 'Back to schedule';
    retry.onclick = async () => {
      if (!isCurrent()) return;
      state.dailyPreparation += 1;
      retry.disabled = true; schedule.disabled = true;
      setDailyStatus(status, 'Reconnecting to your private room…');
      const currentCall = state.dailyCall;
      releaseLiveMembership();
      if (currentCall) {
        state.dailyCall = null;
        await disposeDailyCall(currentCall);
      }
      if (sameSession()) prepareDailyCall();
    };
    schedule.onclick = () => { if (isCurrent()) go('match'); };
    actions.append(retry, schedule); status.append(actions);
  };
  setDailyStatus(status, 'Connecting to your private video room… The first connection can take up to a minute.');
  const connected = await connectSocket();
  if (!isCurrent()) return;
  if (!connected) return showRetry('We could not reach the interview server. It may still be waking up—wait a moment and try again.');
  setDailyStatus(status, 'Preparing secure room access…');
  const access = await request('prepare-call', { roomId }, 30_000);
  if (!isCurrent()) { if (access) access.token = ''; return; }
  if (!access.ok) { showRetry(access.error || 'The private room is not available yet.'); return; }
  if (access.provider !== 'daily') {
    state.match.videoProvider = 'webrtc';
    setDailyStatus(status, 'Using the browser video fallback…');
    if (await ensureMedia() && isCurrent()) session();
    return;
  }
  let call;
  try {
    call = window.DailyIframe.createFrame(container, {
      showLeaveButton: true,
      iframeStyle: { width: '100%', height: '100%', border: '0', borderRadius: '8px' }
    });
  } catch {
    showRetry('Could not start the hosted video panel. Close any other open interview tab and try again.');
    return;
  }
  state.dailyCall = call;
  call.on('joined-meeting', async () => {
    if (!isCurrent(call)) {
      disposeDailyCall(call);
      return;
    }
    if (failed) return;
    setDailyStatus(status, 'Verifying this interview room…');
    const joined = await joinCurrentCallRoom(roomId, generation);
    if (!isCurrent(call)) {
      disposeDailyCall(call);
      return;
    }
    if (failed) { releaseLiveMembership(); return; }
    if (!joined.ok) {
      if (state.liveRoomId === roomId) state.liveRoomId = null;
      if (state.dailyCall === call) state.dailyCall = null;
      showRetry(joined.error || 'This interview room is not available yet.');
      disposeDailyCall(call);
      return;
    }
    setDailyStatus(status, 'Secure video connected.', 'ready');
    if (joined.startedAt) startSyncedTimer(joined.startedAt);
    socket.emit('workspace-request', roomId);
  });
  call.on('left-meeting', () => {
    const wasCurrent = isCurrent(call);
    if (!wasCurrent) { try { call.destroy(); } catch {}; return; }
    if (state.liveRoomId === roomId) {
      state.liveRoomId = null;
      if (socket.connected) socket.emit('leave-session', roomId);
    }
    state.dailyCall = null;
    try { call.destroy(); } catch {}
    if (routeName() === 'session' && state.roomId === roomId) go('match');
  });
  call.on('error', event => { if (isCurrent(call)) showRetry(event?.errorMsg || 'Video connection interrupted. Please retry.'); });
  try {
    await call.join({ url: access.roomUrl, token: access.token });
    access.token = '';
    if (!isCurrent(call)) disposeDailyCall(call);
  } catch {
    access.token = '';
    if (isCurrent(call)) {
      state.dailyCall = null;
      showRetry('Could not enter the hosted video room. Check camera permission and try again.');
      disposeDailyCall(call);
    }
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

async function prepareCall() {
  const roomId = state.roomId, generation = state.callGeneration;
  state.offerStarted = false;
  const pc = state.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.pendingCandidates = [];
  state.stream.getTracks().forEach(track => pc.addTrack(track, state.stream));
  pc.ontrack = event => {
    if (state.pc !== pc || state.roomId !== roomId || state.callGeneration !== generation) return;
    const remote = root.querySelector('#remote'); if (remote) remote.srcObject = event.streams[0]; updateConnection(`${state.match.peer.name} · connected`, true);
  };
  pc.onicecandidate = event => {
    if (event.candidate && state.pc === pc && state.roomId === roomId && state.callGeneration === generation) socket.emit('signal', { roomId, data: { candidate: event.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (state.pc !== pc || state.roomId !== roomId || state.callGeneration !== generation) return;
    if (pc.connectionState === 'failed') updateConnection('Connection failed — check network or try audio-only mode', false);
    if (pc.connectionState === 'disconnected') updateConnection('Video connection interrupted — retrying…', false);
  };
  const joined = await joinCurrentCallRoom(roomId, generation);
  if (state.pc !== pc || state.roomId !== roomId || state.callGeneration !== generation || routeName() !== 'session') return;
  if (!joined.ok) {
    toast(joined.error || 'This interview room is unavailable.');
    go('match');
    return;
  }
  if (joined.startedAt) startSyncedTimer(joined.startedAt);
  socket.emit('workspace-request', roomId);
}

async function handleSignal(data) {
  const roomId = data?.roomId || state.roomId;
  if (roomId !== state.roomId) return;
  const pc = state.pc, generation = state.callGeneration;
  if (!pc) return;
  const isCurrent = () => state.pc === pc && state.roomId === roomId && state.callGeneration === generation && routeName() === 'session';
  try {
    if (data.offer) {
      await pc.setRemoteDescription(data.offer); if (!isCurrent()) return;
      await flushCandidates(pc, isCurrent); if (!isCurrent()) return;
      const answer = await pc.createAnswer(); if (!isCurrent()) return;
      await pc.setLocalDescription(answer); if (!isCurrent()) return;
      socket.emit('signal', { roomId, data: { answer } });
    } else if (data.answer) {
      await pc.setRemoteDescription(data.answer); if (!isCurrent()) return;
      await flushCandidates(pc, isCurrent);
    } else if (data.candidate && isCurrent()) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pc.pendingCandidates.push(data.candidate);
    }
  } catch { if (isCurrent()) updateConnection('Could not establish the video connection. Try rejoining.', false); }
}
async function flushCandidates(pc, isCurrent) {
  while (pc.pendingCandidates.length && isCurrent()) await pc.addIceCandidate(pc.pendingCandidates.shift());
}
function updateConnection(text, ready) {
  const status = root.querySelector('#peer-status'), banner = root.querySelector('#connection');
  if (status) status.textContent = text;
  if (banner) { banner.classList.toggle('ready', ready); banner.querySelector('span').textContent = ready ? 'Secure video connected' : text; }
}

async function finishCurrentSession(roomId, button) {
  const generation = state.callGeneration;
  const isCurrent = () => routeName() === 'session' && state.roomId === roomId && state.callGeneration === generation;
  const label = button?.querySelector('span'), previousLabel = label?.textContent || 'Finish';
  if (button) button.disabled = true;
  if (label) label.textContent = 'Finishing…';
  const restoreButton = message => {
    if (!isCurrent()) return;
    if (button) button.disabled = false;
    if (label) label.textContent = previousLabel;
    toast(message);
  };
  if (!(await connectSocket())) return restoreButton('Could not reach the interview server. Please retry.');
  if (!isCurrent()) return;
  const joined = await joinCurrentCallRoom(roomId, generation);
  if (!isCurrent()) return;
  if (!joined.ok) return restoreButton(joined.error || 'Could not verify this interview room.');
  const result = await request('complete-session', roomId);
  if (!isCurrent()) return;
  if (!result.ok) restoreButton(result.error || 'Could not finish the interview. Please retry.');
}

function startSyncedTimer(startedAt) {
  clearInterval(state.clock); state.clock = null; state.sessionStartedAt = new Date(startedAt).getTime();
  const update = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.sessionStartedAt) / 1000)), totalSeconds = sessionMinutes() * 60, remaining = Math.max(0, totalSeconds - elapsed);
    const value = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    const timer = root.querySelector('#timer'), side = root.querySelector('#side-timer'); if (timer) timer.textContent = value; if (side) side.textContent = value;
    if (!remaining && state.clock) { clearInterval(state.clock); state.clock = null; }
    return remaining;
  };
  if (update()) state.clock = setInterval(update, 1000);
}

function bindWorkspace() {
  const editor = root.querySelector('#shared-code'), language = root.querySelector('#code-language');
  const roomId = state.roomId, generation = state.callGeneration;
  const isCurrent = () => state.roomId === roomId && state.callGeneration === generation && routeName() === 'session';
  let debounce;
  editor.oninput = () => {
    state.workspace.code = editor.value;
    clearTimeout(debounce);
    root.querySelector('#sync-status').textContent = 'Syncing…';
    const code = editor.value, selectedLanguage = language.value;
    debounce = setTimeout(() => { if (isCurrent()) socket.emit('workspace-update', { roomId, code, language: selectedLanguage }); }, 120);
  };
  language.onchange = () => { if (isCurrent()) { state.workspace.language = language.value; socket.emit('workspace-update', { roomId, code: editor.value, language: language.value }); } };
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
  state.callGeneration += 1;
  state.dailyPreparation += 1;
  clearInterval(state.clock); clearInterval(state.joinClock);
  state.stream?.getTracks().forEach(track => track.stop()); state.pc?.close(); state.stream = null; state.pc = null;
  const daily = state.dailyCall; state.dailyCall = null;
  if (daily) disposeDailyCall(daily);
}

function leaveLiveSession(notifyServer = true) {
  const roomId = state.liveRoomId;
  state.liveRoomId = null;
  if (notifyServer && roomId && socket.connected) socket.emit('leave-session', roomId);
  endLocalCall();
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
  const upcomingCount = state.activeMatches.filter(item => !closedMatch(item)).length;
  root.innerHTML = frame(`<section class="simple-page activity-page"><header class="simple-page-heading"><p class="eyebrow">ACTIVITY</p><h1 class="page-title">Your interviews</h1><p class="page-subtitle">${completed} completed interview${completed === 1 ? '' : 's'}.</p></header>
    ${upcomingCount ? `<div class="notice">You have ${upcomingCount} upcoming interview${upcomingCount === 1 ? '' : 's'}. <button class="text-button" data-route="marketplace">View schedule →</button></div>` : ''}
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

function clearActiveMatch(roomId = state.roomId) {
  if (roomId) state.activeMatches = state.activeMatches.filter(item => item.roomId !== roomId);
  persistMatches();
  if (!roomId || state.roomId === roomId) {
    endLocalCall();
    state.match = null; state.roomId = null; state.feedback = null;
    state.workspace = { code: '', language: 'JavaScript', version: 0 };
    state.chat = [];
    localStorage.removeItem(ACTIVE_MATCH_KEY);
  }
}

function resetAccountState() {
  state.liveRoomId = null;
  cancelSocketConnection();
  endLocalCall();
  [PROFILE_KEY, ACTIVE_MATCH_KEY, ACTIVE_MATCHES_KEY].forEach(key => localStorage.removeItem(key));
  sessionStorage.removeItem('mocksyra-mode');
  state.profile = null;
  state.activeMatches = [];
  state.ownListings = [];
  state.match = null;
  state.roomId = null;
  state.feedback = null;
  state.history = [];
  state.notifications = [];
  state.listings = [];
  state.workspace = { code: '', language: 'JavaScript', version: 0 };
  state.chat = [];
  state.selectedMode = null;
  state.restored = false;
}

async function restoreLiveRoomAfterReconnect() {
  const roomId = state.liveRoomId;
  const generation = state.callGeneration;
  const connectionId = socket.id;
  const daily = state.dailyCall;
  const pc = state.pc;
  if (!roomId || roomId !== state.roomId || routeName() !== 'session' || (!daily && !pc)) return;
  if (pc) state.offerStarted = false;
  const joined = await joinCurrentCallRoom(roomId, generation);
  const stillCurrent = socket.connected && socket.id === connectionId && state.roomId === roomId && state.liveRoomId === roomId && state.callGeneration === generation && routeName() === 'session' && (daily ? state.dailyCall === daily : state.pc === pc);
  if (!stillCurrent) return;
  if (!joined.ok) {
    toast(joined.error || 'Your live interview could not reconnect. Please rejoin.');
    leaveLiveSession(false);
    go('match');
    return;
  }
  if (joined.startedAt) startSyncedTimer(joined.startedAt);
  socket.emit('workspace-request', roomId);
}

socket.on('connect', () => {
  const currentAuthKey = authUserKey(state.authUser);
  if (!currentAuthKey || ![connectedAuthKey, connectionPromiseKey].includes(currentAuthKey)) return socket.disconnect();
  socket.emit('restore-profile');
  restoreLiveRoomAfterReconnect();
});
socket.on('match-waiting', () => toast('Your availability is live. We will notify you when an interview is booked.'));
socket.on('match-found', matchData => {
  upsertMatch(matchData);
  if (!state.match || closedMatch(state.match)) selectMatch(matchData);
  if (location.hash === '#marketplace') { renderYourSchedule(); refreshMarketplace(false); }
  else if (['#search', '#onboarding'].includes(location.hash)) go('marketplace');
  else showSystemNotification({ title: 'Your Mocksyra match is ready', body: `You matched with ${matchData.peer.name}.` });
});
socket.on('match-cancelled', packet => {
  const cancelledSelected = !packet?.roomId || packet.roomId === state.roomId;
  clearActiveMatch(packet?.roomId || state.roomId);
  toast(packet?.message || 'This interview was cancelled.');
  if (location.hash === '#marketplace') { renderYourSchedule(); refreshMarketplace(false); }
  else if (cancelledSelected && !['#home', '#auth'].includes(location.hash)) go('marketplace');
});
socket.on('profile-state', restored => {
  const currentEmail = String(state.authUser?.email || '').toLowerCase();
  const restoredEmail = String(restored?.profile?.email || '').toLowerCase();
  if (!socket.connected || connectedAuthKey !== authUserKey(state.authUser) || (restoredEmail && restoredEmail !== currentEmail)) return;
  if (restored && Object.hasOwn(restored, 'profile')) {
    state.profile = restored.profile ? { ...restored.profile } : null;
    if (state.profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
    else localStorage.removeItem(PROFILE_KEY);
  }
  state.restored = true;
  const hasSchedule = Array.isArray(restored?.activeMatches) || Array.isArray(restored?.upcomingMatches) || Object.hasOwn(restored || {}, 'activeMatch');
  applyScheduleResponse(restored);
  const refreshedSelected = state.activeMatches.find(item => item.roomId === state.roomId);
  if (refreshedSelected) selectMatch(refreshedSelected);
  else if (state.match && hasSchedule && !['#feedback', '#dashboard'].includes(location.hash)) {
    const removedRoute = routeName();
    clearActiveMatch(state.roomId);
    if (['match', 'session'].includes(removedRoute)) {
      toast('That interview is no longer in your active schedule.');
      return go('marketplace');
    }
  }
  else if (!state.match && restored?.activeMatch) selectMatch(restored.activeMatch);
  if (Array.isArray(restored?.history)) state.history = restored.history;
  if (Array.isArray(restored?.notifications)) state.notifications = restored.notifications;
  const requestedRoom = roomIdFromHash();
  if (routeName() === 'match' && requestedRoom) {
    const requestedMatch = state.activeMatches.find(item => item.roomId === requestedRoom);
    if (requestedMatch) { selectMatch(requestedMatch); return match(); }
    toast('That interview is no longer in your active schedule.');
    return go('marketplace');
  }
  if (location.hash === '#marketplace' && hasSchedule) renderYourSchedule();
});
socket.on('schedule-updated', schedule => {
  applyScheduleResponse(schedule);
  const refreshedSelected = state.activeMatches.find(item => item.roomId === state.roomId);
  if (refreshedSelected) selectMatch(refreshedSelected);
  if (location.hash === '#marketplace') renderYourSchedule();
});
socket.on('session-listings', listings => { state.listings = listings || []; if (location.hash === '#marketplace') renderMarketplaceResults(); });
socket.on('listings-updated', () => { if (location.hash === '#marketplace') refreshMarketplace(false); });
socket.on('notifications', notifications => { state.notifications = notifications || []; if (location.hash === '#activity') activity(); });
socket.on('notification', notification => { state.notifications = [notification, ...state.notifications.filter(item => item.id !== notification.id)]; showSystemNotification(notification); if (location.hash === '#activity') activity(); });
socket.on('history', history => { state.history = history || []; if (location.hash === '#activity') activity(); });
socket.on('peer-entered-room', packet => {
  if (packet?.roomId && packet.roomId !== state.roomId) return;
  toast('Your interview partner entered the room.');
  const button = root.querySelector('#join');
  if (button) { button.textContent = 'Partner is ready — join now'; button.classList.add('button-light'); }
});
socket.on('session-ready', async packet => {
  const roomId = packet?.roomId || state.roomId;
  const scheduled = state.activeMatches.find(item => item.roomId === roomId);
  if (scheduled) upsertMatch({ ...scheduled, status: 'in_progress', startedAt: packet.startedAt || scheduled.startedAt });
  if (roomId !== state.roomId) { if (location.hash === '#marketplace') renderYourSchedule(); return; }
  if (scheduled) selectMatch({ ...scheduled, status: 'in_progress', startedAt: packet.startedAt || scheduled.startedAt });
  if (packet.startedAt) startSyncedTimer(packet.startedAt);
  if (state.match?.videoProvider === 'daily') {
    const status = root.querySelector('#daily-status');
    if (!status?.classList.contains('error')) setDailyStatus(status, 'Both participants are here. Your session has started.', 'ready');
    return;
  }
  const pc = state.pc, generation = state.callGeneration;
  if (!pc) return;
  const isCurrent = () => state.pc === pc && state.roomId === roomId && state.callGeneration === generation && routeName() === 'session';
  if (state.match?.startsAsInterviewer && !state.offerStarted) {
    state.offerStarted = true;
    const offer = await pc.createOffer(); if (!isCurrent()) return;
    await pc.setLocalDescription(offer); if (!isCurrent()) return;
    socket.emit('signal', { roomId, data: { offer } });
  }
  updateConnection('Partner joined — establishing secure connection…', false);
});
socket.on('signal', handleSignal);
socket.on('workspace-state', workspace => {
  if (workspace?.roomId && workspace.roomId !== state.roomId) return;
  const { roomId, ...roomWorkspace } = workspace || {};
  state.workspace = Object.keys(roomWorkspace).length ? roomWorkspace : state.workspace; const editor = root.querySelector('#shared-code'), language = root.querySelector('#code-language');
  if (editor && document.activeElement !== editor) editor.value = state.workspace.code || ''; if (language) language.value = state.workspace.language || 'JavaScript';
  const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Synced with your partner';
});
socket.on('workspace-update', workspace => {
  if (workspace?.roomId && workspace.roomId !== state.roomId) return;
  const { roomId, ...roomWorkspace } = workspace || {};
  state.workspace = roomWorkspace;
  const editor = root.querySelector('#shared-code'); if (editor && document.activeElement !== editor) editor.value = roomWorkspace.code || '';
  const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Partner updated the workspace';
});
socket.on('chat-state', packet => {
  const roomId = Array.isArray(packet) ? state.roomId : packet?.roomId;
  if (roomId && roomId !== state.roomId) return;
  state.chat = Array.isArray(packet) ? packet : packet?.messages || [];
  renderChat();
});
socket.on('chat-message', message => {
  if (message?.roomId && message.roomId !== state.roomId) return;
  const { roomId, ...item } = message || {};
  state.chat.push(item); renderChat();
});
socket.on('peer-left', packet => { if (!packet?.roomId || packet.roomId === state.roomId) updateConnection('Your partner left the room. They can rejoin.', false); });
socket.on('session-ended', packet => {
  const roomId = packet?.roomId || state.roomId;
  const completedMatch = state.activeMatches.find(item => item.roomId === roomId);
  if (completedMatch) upsertMatch({ ...completedMatch, status: 'feedback_pending' });
  if (roomId !== state.roomId) {
    if (location.hash === '#marketplace') renderYourSchedule();
    return showSystemNotification({ title: 'An interview ended', body: 'Open your schedule when you are ready to leave feedback.' });
  }
  if (completedMatch) selectMatch({ ...completedMatch, status: 'feedback_pending' });
  leaveLiveSession(); go('feedback');
});
socket.on('peer-feedback-submitted', packet => {
  if (packet?.roomId && packet.roomId !== state.roomId) return showSystemNotification({ title: 'Feedback received', body: 'Your partner submitted feedback for another interview.' });
  const button = root.querySelector('#submit');
  if (button?.disabled) button.textContent = 'Partner submitted — finalizing feedback…';
  else toast('Your partner has submitted feedback. Complete yours when ready.');
});
socket.on('feedback-ready', feedbackData => {
  const completedRoomId = feedbackData?.roomId || state.roomId;
  state.activeMatches = state.activeMatches.filter(item => item.roomId !== completedRoomId);
  persistMatches();
  if (completedRoomId !== state.roomId) {
    if (location.hash === '#marketplace') renderYourSchedule();
    socket.emit('restore-profile');
    return showSystemNotification({ title: 'Interview feedback is ready', body: 'Open History to review it.' });
  }
  state.feedback = feedbackData;
  localStorage.removeItem(ACTIVE_MATCH_KEY);
  socket.emit('restore-profile');
  go('dashboard');
});
socket.on('app-error', message => toast(message));
socket.on('connect_error', error => { if (error.message === 'Authentication required') recoverSocketAuthentication(); });

async function logout() {
  logoutInProgress = true;
  let remoteSignOutFailed = false;
  try {
    const result = await window.peerSupabase.auth.signOut();
    remoteSignOutFailed = Boolean(result?.error);
  } catch { remoteSignOutFailed = true; }
  finally {
    if (remoteSignOutFailed) clearSupabaseStoredSession();
    resetAccountState();
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
    window.__mocksyraAuthUser = null;
    window.__mocksyraAccessToken = '';
    state.authUser = null;
    state.authenticated = false;
    state.authResolved = true;
    logoutInProgress = false;
    go('home');
    toast(remoteSignOutFailed ? 'Logged out on this device.' : 'You have been logged out.');
  }
}
document.addEventListener('click', event => { if (event.target.closest('#logout')) logout(); });

const routeName = () => (location.hash.slice(1).split('?')[0] || 'home');
const roomIdFromHash = () => {
  const query = location.hash.slice(1).split('?')[1] || '';
  return new URLSearchParams(query).get('room') || '';
};
const protectedRoutes = ['onboarding', 'marketplace', 'search', 'match', 'session', 'feedback', 'dashboard', 'activity'];
function renderAccountLoading() {
  root.innerHTML = '<div class="app-shell"><main class="app-main"><div class="shell auth-shell"><section class="panel auth-panel"><p class="page-subtitle" role="status">Checking your account…</p></section></div></main></div>';
}
function applyAuthenticatedUser(user, source = '') {
  const wasResolved = state.authResolved;
  const nextKey = authUserKey(user);
  const storedKey = localStorage.getItem(ACCOUNT_KEY) || '';
  const cachedEmail = String(localStorage.getItem(EMAIL_KEY) || '').toLowerCase();
  const nextEmail = String(user?.email || '').toLowerCase();
  const previousKey = authUserKey(state.authUser);
  const accountChanged = Boolean(nextKey && ((storedKey && storedKey !== nextKey) || (!storedKey && cachedEmail && cachedEmail !== nextEmail) || (previousKey && previousKey !== nextKey)));
  state.authResolved = true;
  if (!nextKey) {
    resetAccountState();
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem(ACCOUNT_KEY);
    state.authUser = null;
    state.authenticated = false;
    state.authResolved = true;
    if (!logoutInProgress && protectedRoutes.includes(routeName())) go('auth');
    return;
  }
  if (accountChanged) resetAccountState();
  state.authUser = user;
  state.authenticated = true;
  state.authResolved = true;
  localStorage.setItem(EMAIL_KEY, user.email);
  localStorage.setItem(ACCOUNT_KEY, nextKey);
  updateAccountHeader();
  if (accountChanged && protectedRoutes.includes(routeName())) {
    window.history.replaceState({}, '', `${location.pathname}#marketplace`);
    return router();
  }
  if (!wasResolved) return router();
  if ((source === 'SIGNED_IN' || (source === 'TOKEN_REFRESHED' && !authRecoveryPromise)) && routeName() === 'auth') go('marketplace');
}

function router() {
  const route = routeName();
  const previousRoute = state.activeRoute;
  if (previousRoute === 'session' && route !== 'session') leaveLiveSession();
  else if (previousRoute === 'match' && !['match', 'session'].includes(route)) endLocalCall();
  state.activeRoute = route;
  if (route === 'auth') return window.renderAuthPage();
  if (protectedRoutes.includes(route) && !state.authResolved) return renderAccountLoading();
  if (protectedRoutes.includes(route) && !localStorage.getItem(EMAIL_KEY)) return window.renderAuthPage();
  if (route === 'match' && roomIdFromHash()) {
    const requestedMatch = state.activeMatches.find(item => item.roomId === roomIdFromHash());
    if (requestedMatch) selectMatch(requestedMatch);
    else if (!state.restored || !state.profile) {
      root.innerHTML = frame('<section class="simple-page"><section class="panel"><p class="page-subtitle" role="status">Loading this interview…</p></section></section>');
      connectSocket();
      return;
    } else {
      toast('That interview is no longer in your active schedule.');
      return go('marketplace');
    }
  }
  const active = readJson(ACTIVE_MATCH_KEY, null);
  if (!state.match && active) { state.match = active; state.roomId = active.roomId; }
  const routes = { onboarding, marketplace, search, match, session, feedback, dashboard, activity };
  (routes[route] || home)();
  if (localStorage.getItem(EMAIL_KEY)) connectSocket();
}
window.navigateMocksyra = route => { if (location.hash === `#${route}`) router(); else go(route); };

window.addEventListener('hashchange', router);
window.addEventListener('mocksyra-auth-user', event => {
  if (event.detail?.accessToken) socket.auth = { accessToken: event.detail.accessToken };
  applyAuthenticatedUser(event.detail?.user || null, event.detail?.source || '');
});
async function restoreAuthentication() {
  try {
    const { data } = await window.peerSupabase.auth.getSession();
    applyAuthenticatedUser(data.session?.user || null, 'RESTORED');
  } catch {
    state.authResolved = true;
    if (protectedRoutes.includes(routeName())) go('auth');
  }
}
router();
restoreAuthentication();
