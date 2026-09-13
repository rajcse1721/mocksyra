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
const experienceLevels = ['Beginner', 'Intermediate', 'Advanced'];
const spokenLanguages = ['English', 'Hindi', 'English + Hindi'];

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
};

const state = {
  profile: readJson(PROFILE_KEY, null),
  match: null,
  roomId: null,
  notifications: [],
  history: [],
  pendingCandidates: [],
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
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), duration);
};


const modes = {
  candidate: { title: 'Candidate', icon: 'user', duration: 45, target: 'an interviewer', description: 'Get comfortable answering questions. Receive focused feedback from a volunteer interviewer.' },
  interviewer: { title: 'Interviewer', icon: 'briefcase', duration: 45, target: 'a candidate', description: 'Lead a mock interview, share what you know, and build your interviewing skills.' },
  peer: { title: 'Peer Practice', icon: 'users', duration: 90, target: 'a practice peer', description: 'Learn both sides. Interview each other and switch roles halfway through.' }
};
const normalizedMode = value => modes[value] ? value : 'peer';
const modeFor = () => modes[normalizedMode(state.match?.practiceMode || state.profile?.practiceMode)];
const isPeerSession = () => !state.match?.sessionMode || state.match.sessionMode === 'peer';
const sessionMinutes = () => Number(state.match?.durationMinutes) || (isPeerSession() ? 90 : 45);
const closedMatch = match => !match || ['completed', 'cancelled', 'expired'].includes(match.status);
const noteKey = () => `mocksyra-notes-${localStorage.getItem(EMAIL_KEY)}-${state.roomId}`;
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
function stepper(step) {
  return `<div class="stepper" aria-label="Interview progress">${['Preferences', 'Your match', 'Practice', 'Feedback'].map((label, i) => `<span class="${i < step ? 'done' : i === step ? 'current' : ''}" ${i === step ? 'aria-current="step"' : ''}><i>${i < step ? '✓' : i + 1}</i>${label}</span>`).join('')}</div>`;
}
function frame(content) {
  const name = state.profile?.name || 'Your profile';
  const unread = state.notifications.filter(item => !item.read).length;
  return `<div class="app-shell">
    <header class="app-nav"><div class="shell">
      <a class="brand" href="#home"><i>◒</i> Mocksyra</a>
      <nav class="profile-menu" aria-label="Account">
        <button class="text-button" data-route="onboarding">Find a session</button>
        <button class="nav-activity" data-route="activity">Activity${unread ? `<span>${unread}</span>` : ''}</button>
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
  const account = document.createElement('button');
  account.className = 'text-button';
  account.textContent = state.authenticated ? 'My activity' : 'Sign in';
  account.onclick = () => go(state.authenticated ? 'activity' : 'auth');
  root.querySelector('.nav').insertBefore(account, root.querySelector('.nav .button'));
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

function choiceButtons(values, selected = []) {
  return values.map(value => `<button class="choice ${selected.includes(value) ? 'selected' : ''}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('');
}


function onboarding() {
  const previous = state.profile || {};
  let selectedMode = normalizedMode(state.selectedMode || previous.practiceMode);
  const selectedSkills = new Set(previous.languages || []);
  const slots = availableSlots();
  const selectedSlots = new Set((previous.slots || []).filter(value => slots.some(slot => slot.value === value)));
  const currentMatch = !closedMatch(state.match);
  root.innerHTML = frame(`${stepper(0)}
    <div class="onboarding-heading"><p class="eyebrow">MAKE YOUR NEXT INTERVIEW FEEL FAMILIAR</p><h1 class="page-title">How would you like to practise?</h1>
    <p class="page-subtitle">Pick a role for this session. You can choose a different one next time.</p></div>
    ${currentMatch ? '<div class="notice">You already have a session waiting. <button class="text-button" data-route="match">Open your match →</button></div>' : ''}
    <div class="mode-grid" role="group" aria-label="Practice mode">
      ${['candidate', 'interviewer', 'peer'].map(key => `<button type="button" class="mode-card ${selectedMode === key ? 'selected' : ''}" data-mode="${key}" aria-pressed="${selectedMode === key}">
        <span class="mode-icon">${icon(modes[key].icon)}</span><span class="mode-check">${icon('check')}</span>
        <span class="mode-title">${modes[key].title}</span><span class="mode-description">${modes[key].description}</span>
        <span class="mode-meta">${icon('clock')}${modes[key].duration} minutes · ${key === 'peer' ? 'Both roles' : 'One role'}</span>
      </button>`).join('')}
    </div>
    <div class="onboarding-layout"><form id="preferences-form" class="panel onboarding-form">
      <div class="panel-heading"><div><p class="eyebrow">THE RIGHT PERSON. THE RIGHT PRACTICE.</p><h2>Your session preferences</h2></div></div>
      <div class="form-grid">
        <div><label class="field-label" for="name">Display name</label><input id="name" class="textarea input" maxlength="40" required autocomplete="nickname" value="${escapeHtml(previous.name || '')}" placeholder="What should we call you?"></div>
        <div><label class="field-label" for="interview-type">Interview focus</label><select id="interview-type" class="select">${interviewTypes.map(value => `<option ${value === previous.interviewType ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></div>
        <div><label class="field-label" for="experience">Your experience level</label><select id="experience" class="select">${experienceLevels.map(value => `<option ${value === previous.experience ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div><label class="field-label" for="spoken-language">Conversation language</label><select id="spoken-language" class="select">${spokenLanguages.map(value => `<option ${value === previous.spokenLanguage ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
      </div>
      <fieldset class="preference-fieldset"><legend class="field-label">What would you like to work on?</legend><p class="field-help">Choose the technologies you’re comfortable using.</p>
      <div class="choices" id="languages">${skills.map(value => `<button type="button" class="choice ${selectedSkills.has(value) ? 'selected' : ''}" data-value="${escapeHtml(value)}" aria-pressed="${selectedSkills.has(value)}">${escapeHtml(value)}</button>`).join('')}</div></fieldset>
      <fieldset class="preference-fieldset"><legend class="field-label">When are you available?</legend><p class="field-help">Choose up to 3 start times. All times in ${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}.</p>
      <div class="slots" id="slots">${slots.map(slot => `<button type="button" class="slot ${selectedSlots.has(slot.value) ? 'selected' : ''}" data-value="${slot.value}" aria-pressed="${selectedSlots.has(slot.value)}">${escapeHtml(slot.label)}</button>`).join('')}</div></fieldset>
      <p id="preference-error" class="form-error" role="alert"></p>
      <div class="form-actions"><span class="hint" id="selection-count"></span><button type="submit" class="button" id="find" ${currentMatch ? 'disabled' : ''}>Find my match ${icon('arrow')}</button></div>
    </form><aside class="preference-aside"><section class="summary-card">
      <p class="eyebrow">YOUR NEXT SESSION</p><h2 id="summary-mode"></h2><p id="summary-description"></p>
      <dl class="session-summary"><div><dt>Session length</dt><dd id="summary-duration"></dd></div><div><dt>You’ll meet</dt><dd id="summary-partner"></dd></div><div><dt>Availability</dt><dd id="summary-times"></dd></div><div><dt>Cost</dt><dd>Free</dd></div></dl>
      <div class="summary-note">${icon('check')}<span>Real people. A shared workspace. Feedback to take into your next interview.</span></div>
    </section><p class="field-help">Interviewer sessions are community practice with volunteers. Matching depends on compatible participants being available.</p></aside></div>`);
  bindRoutes();
  const updateSummary = () => {
    const mode = modes[selectedMode];
    root.querySelector('#summary-mode').textContent = mode.title;
    root.querySelector('#summary-description').textContent = selectedMode === 'peer' ? '45 minutes on each side of the table.' : selectedMode === 'candidate' ? 'Space to think, answer, and learn.' : 'Guide the conversation. Help someone grow.';
    root.querySelector('#summary-duration').textContent = `${mode.duration} minutes`;
    root.querySelector('#summary-partner').textContent = mode.target;
    root.querySelector('#summary-times').textContent = `${selectedSlots.size} time${selectedSlots.size === 1 ? '' : 's'} selected`;
    root.querySelector('#selection-count').textContent = `${selectedSlots.size}/3 times selected · ${mode.duration}-minute session`;
  };
  root.querySelectorAll('.mode-card').forEach(button => button.onclick = () => {
    selectedMode = button.dataset.mode; state.selectedMode = selectedMode; sessionStorage.setItem('mocksyra-mode', selectedMode);
    root.querySelectorAll('.mode-card').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button); });
    updateSummary();
  });
  root.querySelectorAll('#languages button').forEach(button => button.onclick = () => {
    selectedSkills.has(button.dataset.value) ? selectedSkills.delete(button.dataset.value) : selectedSkills.add(button.dataset.value);
    button.classList.toggle('selected', selectedSkills.has(button.dataset.value)); button.setAttribute('aria-pressed', selectedSkills.has(button.dataset.value));
  });
  root.querySelectorAll('#slots button').forEach(button => button.onclick = () => {
    if (!selectedSlots.has(button.dataset.value) && selectedSlots.size >= 3) return toast('Choose up to three times.');
    selectedSlots.has(button.dataset.value) ? selectedSlots.delete(button.dataset.value) : selectedSlots.add(button.dataset.value);
    button.classList.toggle('selected', selectedSlots.has(button.dataset.value)); button.setAttribute('aria-pressed', selectedSlots.has(button.dataset.value)); updateSummary();
  });
  root.querySelector('#preferences-form').onsubmit = async event => {
    event.preventDefault();
    const error = root.querySelector('#preference-error'), button = root.querySelector('#find');
    const name = root.querySelector('#name').value.trim();
    if (!name || !selectedSkills.size || !selectedSlots.size) { error.textContent = 'Add your name, at least one technology, and a time to continue.'; return; }
    state.profile = { ...previous, name, practiceMode: selectedMode, languages: [...selectedSkills], slots: [...selectedSlots],
      interviewType: root.querySelector('#interview-type').value, experience: root.querySelector('#experience').value,
      spokenLanguage: root.querySelector('#spoken-language').value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
    button.disabled = true; button.textContent = 'Connecting…'; error.textContent = '';
    if (!(await connectSocket())) { button.disabled = false; button.textContent = 'Try again'; error.textContent = 'Could not reach matching. Your preferences are saved.'; return; }
    button.textContent = 'Finding your match…';
    saveProfileToSupabase(state.profile);
    const result = await request('find-match', state.profile);
    if (!result.ok) { button.disabled = false; button.textContent = 'Find my match'; error.textContent = result.error; return; }
    if (location.hash === '#onboarding') go(closedMatch(state.match) ? 'search' : 'match');
  };
  updateSummary();
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

function search() {
  if (!state.profile) return go('onboarding');
  root.innerHTML = frame(`${stepper(1)}
    <section class="match-card searching-card"><span class="match-badge">● LIVE MATCHING</span>
      <div class="large-match"><div class="portrait coral">${escapeHtml(state.profile.name[0])}</div><div class="link pulse">⌁</div><div class="portrait lime">?</div></div>
      <h2>Looking for ${modes[normalizedMode(state.profile.practiceMode)].target}…</h2><p class="page-subtitle centered">We require a shared time, interview type, and technology. You can safely return later—your queue entry remains until its selected times pass.</p>
      <div class="search-tags"><span>${modes[normalizedMode(state.profile.practiceMode)].title}</span><span>${escapeHtml(state.profile.interviewType)}</span><span>${escapeHtml(state.profile.experience)}</span><span>${escapeHtml(state.profile.languages.join(' · '))}</span></div>
      <button class="text-button" id="cancel">Cancel search</button></section>`);
  bindRoutes();
  root.querySelector('#cancel').onclick = async () => { const result = await request('cancel-search'); if (!result.ok) return toast(result.error); state.profile.status = 'idle'; toast('Search cancelled. Update your preferences whenever you’re ready.'); go('onboarding'); };
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

function match() {
  if (!state.match || !state.profile) return go('onboarding');
  const peer = state.match.peer;
  const reasons = state.match.reasons || [];
  const feedbackPending = state.match.status === 'feedback_pending';
  root.innerHTML = frame(`<div class="progress"><i class="done"></i><i class="done"></i><i></i><i></i></div>
    <h1 class="page-title">Your practice match is ready.</h1><p class="page-subtitle">${modeFor().title} · ${sessionMinutes()} minutes · ${isPeerSession() ? "You’ll switch roles halfway through." : `You will stay in the ${escapeHtml(state.match.practiceMode)} role.`}</p>
    <div class="match-layout"><section class="match-card"><span class="match-badge">✦ ${state.match.score}% COMPATIBLE</span>
      <div class="large-match"><div><div class="portrait coral">${escapeHtml(state.profile.name[0])}</div><small>You</small></div><div class="link">⌁</div><div><div class="portrait lime">${escapeHtml(peer.name[0])}</div><small>${escapeHtml(peer.name.split(' ')[0])}</small></div></div>
      <div class="mode-pill">${icon(modeFor().icon)} ${modeFor().title} · ${sessionMinutes()} min</div><h2>Meet ${escapeHtml(peer.name)}</h2>
      <p class="page-subtitle">${escapeHtml(state.match.interviewType)} · ${escapeHtml(peer.experience)} · ${escapeHtml(formatSlot(state.match.sharedSlot))}</p>
      <div class="reason-list">${reasons.map(reason => `<span>✓ ${escapeHtml(reason)}</span>`).join('')}</div>
      <div class="button-row"><button class="button secondary" id="calendar">Add to calendar</button><button class="button" id="join">${feedbackPending ? 'Continue to feedback' : 'Join interview room'} <b>→</b></button></div>
    </section><aside class="side-card device-card"><h3>Before you begin</h3><p>Test your devices here. If another browser is using your camera, Mocksyra automatically tries audio-only mode.</p>
      <video id="device-preview" autoplay muted playsinline hidden></video><p class="device-status" id="device-status">Devices not tested</p>
      <button class="button button-light full" id="test-devices">Test camera & mic</button><div class="peer-stat"><b>${Number(peer.sessionsCompleted || 0)}</b><span>completed peer sessions</span></div>
    </aside></div>${state.match.status === 'matched' ? '<button class="text-button cancel-match" id="cancel-match">Cancel this match and change preferences</button>' : ''}`);
  bindRoutes();
  root.querySelector('#test-devices').onclick = deviceCheck;
  root.querySelector('#calendar').onclick = downloadCalendar;
  root.querySelector('#cancel-match')?.addEventListener('click', async () => {
    if (!confirm('Cancel this match for both participants?')) return;
    const result = await request('cancel-match', state.roomId);
    if (!result.ok) return toast(result.error);
    clearActiveMatch(); go('onboarding');
  });
  root.querySelector('#join').onclick = async () => {
    if (feedbackPending) return go('feedback');
    if (await connectSocket() && await ensureMedia()) go('session');
  };
}

function calendarDate(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function downloadCalendar() {
  if (!state.match?.sharedSlot) return toast('No scheduled time is available.');
  const start = new Date(state.match.sharedSlot), end = new Date(start.getTime() + sessionMinutes() * 60 * 1000);
  const url = `${location.origin}${location.pathname}#match`;
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mocksyra//Peer Interview//EN', 'BEGIN:VEVENT',
    `UID:${state.roomId}@mocksyra`, `DTSTAMP:${calendarDate(new Date())}`, `DTSTART:${calendarDate(start)}`, `DTEND:${calendarDate(end)}`,
    `SUMMARY:Mocksyra interview with ${state.match.peer.name}`, `DESCRIPTION:Open Mocksyra to join your peer interview: ${url}`, `URL:${url}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' })); link.download = 'mocksyra-interview.ics'; link.click(); URL.revokeObjectURL(link.href);
}

function session() {
  if (!state.match || !state.stream?.active) return go('match');
  const peer = state.match.peer, question = state.match.question || {}, startsAsInterviewer = state.match.startsAsInterviewer;
  const peerSession = isPeerSession(), minutes = sessionMinutes(), initialTimer = `${minutes}:00`;
  const sessionIntro = peerSession ? 'The 90-minute agenda starts when both participants join.' : `This focused ${minutes}-minute session starts when both participants join.`;
  const agenda = peerSession
    ? `<div class="agenda-item active" id="agenda-one"><b>Part 1 · ${startsAsInterviewer ? escapeHtml(peer.name.split(' ')[0]) : 'You'} ${startsAsInterviewer ? 'is' : 'are'} candidate</b><small>First 45 minutes.</small></div><div class="agenda-item" id="agenda-two"><b>Part 2 · ${startsAsInterviewer ? 'You are' : `${escapeHtml(peer.name.split(' ')[0])} is`} candidate</b><small>Roles switch automatically.</small></div>`
    : `<div class="agenda-item active" id="agenda-one"><b>${startsAsInterviewer ? 'You are leading the interview' : `You are the candidate`}</b><small>Your role stays the same for this session.</small></div>`;
  root.innerHTML = frame(`<div class="progress"><i class="done"></i><i class="done"></i><i class="done"></i><i></i></div>
    <div class="session-heading"><div><h1 class="page-title">Interview room</h1><p class="page-subtitle">${sessionIntro}</p></div><div class="room-code">ROOM ${escapeHtml(state.roomId.slice(-6).toUpperCase())}</div></div>
    <div class="session-tools"><button class="tool-tab selected" data-tab="video-panel">Video</button><button class="tool-tab" data-tab="workspace-panel">Shared workspace</button><button class="tool-tab" data-tab="chat-panel">Chat</button></div>
    <div class="session"><section class="session-main">
      <div class="call-stage tool-panel" id="video-panel"><div class="call-top"><span class="live">● LIVE SESSION</span><span id="timer">${initialTimer}</span></div>
        <div class="connection-banner" id="connection"><i></i><span>Waiting for ${escapeHtml(peer.name)} to join the room…</span></div>
        <div class="call-users"><div class="video"><video id="local" autoplay muted playsinline></video><small>You</small></div><div class="video"><video id="remote" autoplay playsinline></video><small id="peer-status">${escapeHtml(peer.name)} · not connected</small></div></div>
        <div class="call-controls"><button class="call-action" id="mic" title="Toggle microphone"><b>●</b><span>Microphone</span></button><button class="call-action" id="cam" title="Toggle camera"><b>◉</b><span>Camera</span></button><button class="call-action end" id="complete" title="Finish interview"><b>×</b><span>Finish</span></button></div></div>
      <div class="workspace-card tool-panel" id="workspace-panel" hidden><div class="workspace-head"><div><span class="eyebrow">LIVE SHARED PAD</span><h2>${escapeHtml(question.title || 'Collaborative workspace')}</h2></div><select id="code-language" class="select compact">${['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'SQL', 'Plain text'].map(value => `<option ${value === state.workspace.language ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="question-box"><b>Your interviewer brief</b><p>${escapeHtml(question.prompt || 'Use the shared pad to work through your interview question.')}</p>${question.hints?.length ? `<details><summary>Hints for the interviewer</summary><ul>${question.hints.map(hint => `<li>${escapeHtml(hint)}</li>`).join('')}</ul></details>` : ''}</div>
        <textarea id="shared-code" class="code-editor" spellcheck="false">${escapeHtml(state.workspace.code || question.starter || '')}</textarea>
        <div class="workspace-actions"><span id="sync-status">Synced with your peer</span><button class="button secondary" id="copy-code">Copy</button><button class="button" id="run-code">Run JavaScript</button></div><pre id="code-output" class="code-output">Output will appear here.</pre></div>
      <div class="workspace-card tool-panel" id="chat-panel" hidden><div class="workspace-head"><div><span class="eyebrow">ROOM CHAT</span><h2>Messages with ${escapeHtml(peer.name)}</h2></div></div><div class="chat-messages" id="chat-messages"></div><div class="chat-compose"><input id="chat-input" class="textarea input" maxlength="500" placeholder="Send a useful link or short message"><button class="button" id="send-chat">Send</button></div></div>
    </section><aside class="agenda"><h3>Session agenda</h3><div class="timer" id="side-timer">${initialTimer}</div>
      ${agenda}
      <div class="agenda-item" id="agenda-feedback"><b>Peer feedback</b><small>Unlocked after the call.</small></div>
      <label class="field-label">PRIVATE NOTES</label><textarea id="private-notes" class="textarea" placeholder="Only you can see these notes."></textarea></aside></div>`);
  bindRoutes();
  root.querySelector('#local').srcObject = state.stream;
  root.querySelector('#private-notes').value = localStorage.getItem(`mocksyra-notes-${state.roomId}`) || '';
  root.querySelector('#private-notes').oninput = event => localStorage.setItem(`mocksyra-notes-${state.roomId}`, event.target.value);
  bindSessionTabs(); bindWorkspace(); bindChat(); renderChat(); prepareCall();
  root.querySelector('#mic').onclick = event => toggleTrack('audio', event.currentTarget);
  root.querySelector('#cam').onclick = event => toggleTrack('video', event.currentTarget);
  root.querySelector('#complete').onclick = () => { if (confirm('Finish the interview for both participants and open feedback?')) socket.emit('complete-session', state.roomId); };
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
    if (pc.connectionState === 'disconnected') updateConnection('Peer connection interrupted — retrying…', false);
  };
  socket.emit('join-session', state.roomId); socket.emit('workspace-request', state.roomId);
}

async function handleSignal(data) {
  const pc = state.pc; if (!pc) return;
  try {
    if (data.offer) { await pc.setRemoteDescription(data.offer); await flushCandidates(); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('signal', { roomId: state.roomId, data: { answer } }); }
    else if (data.answer) { await pc.setRemoteDescription(data.answer); await flushCandidates(); }
    else if (data.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else state.pendingCandidates.push(data.candidate); }
  } catch { updateConnection('Could not establish the peer connection. Try rejoining.', false); }
}
async function flushCandidates() { while (state.pendingCandidates.length) await state.pc.addIceCandidate(state.pendingCandidates.shift()); }
function updateConnection(text, ready) {
  const status = root.querySelector('#peer-status'), banner = root.querySelector('#connection');
  if (status) status.textContent = text;
  if (banner) { banner.classList.toggle('ready', ready); banner.querySelector('span').textContent = ready ? 'Secure peer-to-peer call connected' : text; }
}

function startSyncedTimer(startedAt) {
  clearInterval(state.clock); state.sessionStartedAt = new Date(startedAt).getTime();
  const update = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - state.sessionStartedAt) / 1000)), totalSeconds = sessionMinutes() * 60, remaining = Math.max(0, totalSeconds - elapsed);
    const value = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    const timer = root.querySelector('#timer'), side = root.querySelector('#side-timer'); if (timer) timer.textContent = value; if (side) side.textContent = value;
    const secondHalf = isPeerSession() && elapsed >= 2700;
    root.querySelector('#agenda-one')?.classList.toggle('active', !secondHalf); root.querySelector('#agenda-two')?.classList.toggle('active', secondHalf);
    if (isPeerSession() && elapsed === 2700) toast('45 minutes complete — switch interviewer and candidate roles.', 5000);
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

function endLocalCall() { clearInterval(state.clock); state.stream?.getTracks().forEach(track => track.stop()); state.pc?.close(); state.stream = null; state.pc = null; }

function feedback() {
  if (!state.match) return go('activity');
  const peer = state.match.peer, criteria = ['Problem solving', 'Communication', 'Technical depth'];
  root.innerHTML = frame(`<div class="progress"><i class="done"></i><i class="done"></i><i class="done"></i><i class="done"></i></div>
    <h1 class="page-title">Share thoughtful feedback.</h1><p class="page-subtitle">Your peer sees it only after both of you submit.</p>
    <div class="feedback-grid"><section class="panel"><h2>Rate ${escapeHtml(peer.name.split(' ')[0])}'s interview</h2>
      ${criteria.map((criterion, index) => `<label class="field-label">${criterion.toUpperCase()}</label><div class="rating-row" data-index="${index}">${[1, 2, 3, 4, 5].map(score => `<button data-score="${score}" aria-label="${score} stars">★</button>`).join('')}</div>`).join('')}
      <label class="field-label">WHAT DID THEY DO WELL?</label><textarea id="strength" class="textarea" maxlength="1200" placeholder="Be specific and useful."></textarea></section>
      <section class="panel"><h2>Help them improve</h2><label class="field-label">ONE AREA TO WORK ON</label><textarea id="improve" class="textarea" maxlength="1200" placeholder="Suggest one actionable next step."></textarea>
      <label class="field-label">WOULD YOU PRACTISE TOGETHER AGAIN?</label><div class="choices"><button class="choice" data-repeat="yes">Yes</button><button class="choice" data-repeat="no">Not now</button></div>
      <div class="form-actions"><span class="hint">Feedback is private to your peer.</span><button class="button" id="submit">Submit feedback <b>→</b></button></div></section></div>`);
  bindRoutes(); const scores = [0, 0, 0]; let practiseAgain = null;
  root.querySelectorAll('.rating-row').forEach(row => row.querySelectorAll('button').forEach(button => button.onclick = () => {
    const index = Number(row.dataset.index), score = Number(button.dataset.score); scores[index] = score;
    row.querySelectorAll('button').forEach(item => item.classList.toggle('selected', Number(item.dataset.score) <= score));
  }));
  root.querySelectorAll('[data-repeat]').forEach(button => button.onclick = () => { practiseAgain = button.dataset.repeat === 'yes'; root.querySelectorAll('[data-repeat]').forEach(item => item.classList.toggle('selected', item === button)); });
  root.querySelector('#submit').onclick = () => {
    const strength = root.querySelector('#strength').value.trim(), improve = root.querySelector('#improve').value.trim();
    if (scores.some(score => !score)) return toast('Please rate all three areas.');
    if (strength.length < 5 || improve.length < 5) return toast('Add a short strength and an actionable improvement.');
    const button = root.querySelector('#submit'); button.disabled = true; button.textContent = 'Waiting for peer…';
    socket.emit('submit-feedback', { roomId: state.roomId, feedback: { scores, strength, improve, practiseAgain } });
  };
}

function dashboard() {
  if (!state.feedback || !state.profile || !state.match) return go('activity');
  const feedback = state.feedback, average = (feedback.scores.reduce((sum, score) => sum + score, 0) / feedback.scores.length).toFixed(1);
  root.innerHTML = frame(`<div class="eyebrow"><span></span> SESSION COMPLETE</div><h1 class="page-title">Nice work, ${escapeHtml(state.profile.name.split(' ')[0])}.</h1>
    <p class="page-subtitle">Both feedback forms are in. Your result has been added to Activity.</p>
    <div class="dashboard-grid"><section class="panel"><h2>Your practice summary</h2><div class="metric-row"><div class="metric"><b>1</b><small>SESSION COMPLETE</small></div><div class="metric"><b>${average}/5</b><small>PEER RATING</small></div><div class="metric"><b>${sessionMinutes()}</b><small>PLANNED MINUTES</small></div></div>
      <h3 class="section-subhead">Feedback from ${escapeHtml(state.match.peer.name)}</h3><div class="feedback-item"><b>What you did well</b>${escapeHtml(feedback.strength || 'No written feedback provided.')}</div><div class="feedback-item"><b>Focus for next time</b>${escapeHtml(feedback.improve || 'Keep practising clear problem decomposition.')}</div>
    </section><aside class="side-card"><h3>Keep the momentum</h3><p>Use Activity to revisit feedback or download your session summary.</p><button class="button button-light full" data-route="onboarding">Book another session <b>→</b></button><button class="text-button light-link" data-route="activity">View activity</button></aside></div>`);
  bindRoutes();
}

function activity() {
  const completed = state.history.length, averages = state.history.flatMap(item => item.feedbackReceived?.scores || []);
  const average = averages.length ? (averages.reduce((sum, score) => sum + score, 0) / averages.length).toFixed(1) : '—';
  root.innerHTML = frame(`<button class="back" data-route="onboarding">← BACK TO MATCHING</button><h1 class="page-title">Your Mocksyra activity</h1><p class="page-subtitle">Matches, reminders, and completed feedback stay together here.</p>
    <div class="metric-row activity-metrics"><div class="metric"><b>${completed}</b><small>SESSIONS</small></div><div class="metric"><b>${average}${average === '—' ? '' : '/5'}</b><small>AVERAGE RATING</small></div><div class="metric"><b>${state.history.reduce((total, item) => total + (Number(item.durationMinutes) || (item.sessionMode === 'directed' ? 45 : 90)), 0)}</b><small>PLANNED MINUTES</small></div></div>
    <div class="activity-grid"><section class="panel"><div class="panel-heading"><h2>Session history</h2>${state.match ? '<button class="button secondary" data-route="match">Open active match</button>' : ''}</div>
      <div class="history-list">${state.history.length ? state.history.map((item, index) => `<article class="history-card"><div><span class="match-badge">${escapeHtml(item.interviewType)}</span><h3>${escapeHtml(item.peer.name)}</h3><p>${escapeHtml(formatSlot(item.sharedSlot))} · ${escapeHtml(item.peer.experience)}</p></div><div><b>${item.feedbackReceived ? `${(item.feedbackReceived.scores.reduce((a, b) => a + b, 0) / 3).toFixed(1)}/5` : 'Pending'}</b><button class="text-button" data-summary="${index}">Download summary</button></div></article>`).join('') : '<p class="empty-state">Complete your first interview to build a feedback history.</p>'}</div>
    </section><aside class="panel"><div class="panel-heading"><h2>Notifications</h2><button class="text-button" id="enable-alerts">Enable browser alerts</button></div>
      <div class="notification-list">${state.notifications.length ? state.notifications.map(item => `<article><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.body)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></article>`).join('') : '<p class="empty-state">No notifications yet.</p>'}</div></aside></div>`);
  bindRoutes();
  root.querySelector('#enable-alerts').onclick = async () => {
    if (!('Notification' in window)) return toast('Browser notifications are not supported here.');
    const result = await Notification.requestPermission(); toast(result === 'granted' ? 'Browser alerts enabled while your browser is running.' : 'Notification permission was not enabled.');
  };
  root.querySelectorAll('[data-summary]').forEach(button => button.onclick = () => downloadSummary(state.history[Number(button.dataset.summary)]));
}

function downloadSummary(item) {
  const feedbackData = item.feedbackReceived;
  const text = ['MOCKSYRA SESSION SUMMARY', `Peer: ${item.peer.name}`, `Type: ${item.interviewType}`, `Time: ${formatSlot(item.sharedSlot)}`, '', 'WHAT WENT WELL', feedbackData?.strength || 'Feedback pending', '', 'FOCUS FOR NEXT TIME', feedbackData?.improve || 'Feedback pending'].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  link.download = `mocksyra-${new Date(item.completedAt || Date.now()).toISOString().slice(0, 10)}.txt`; link.click(); URL.revokeObjectURL(link.href);
}

function showSystemNotification(item) {
  toast(item.title);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(item.title, { body: item.body });
}

socket.on('connect', () => socket.emit('restore-profile'));
socket.on('match-waiting', () => toast('You are in the queue. We will notify you when a compatible peer is found.'));
socket.on('match-found', matchData => {
  state.match = matchData; state.roomId = matchData.roomId; localStorage.setItem('mocksyra-active-match', JSON.stringify(matchData));
  if (location.hash === '#search' || location.hash === '#onboarding') go('match'); else showSystemNotification({ title: 'Your Mocksyra match is ready', body: `You matched with ${matchData.peer.name}.` });
});
socket.on('notifications', notifications => { state.notifications = notifications || []; if (location.hash === '#activity') activity(); });
socket.on('notification', notification => { state.notifications = [notification, ...state.notifications.filter(item => item.id !== notification.id)]; showSystemNotification(notification); if (location.hash === '#activity') activity(); });
socket.on('history', history => { state.history = history || []; if (location.hash === '#activity') activity(); });
socket.on('peer-entered-room', () => { toast('Your peer entered the room.'); const button = root.querySelector('#join'); if (button) { button.innerHTML = 'Peer is ready — join now <b>→</b>'; button.classList.add('button-light'); } });
socket.on('session-ready', async packet => {
  if (!state.pc) return; startSyncedTimer(packet.startedAt);
  if (state.match?.startsAsInterviewer && !state.offerStarted) { state.offerStarted = true; const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer); socket.emit('signal', { roomId: state.roomId, data: { offer } }); }
  updateConnection('Peer joined — establishing secure connection…', false);
});
socket.on('signal', handleSignal);
socket.on('workspace-state', workspace => {
  state.workspace = workspace || state.workspace; const editor = root.querySelector('#shared-code'), language = root.querySelector('#code-language');
  if (editor && document.activeElement !== editor) editor.value = state.workspace.code || ''; if (language) language.value = state.workspace.language || 'JavaScript';
  const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Synced with your peer';
});
socket.on('workspace-update', workspace => { state.workspace = workspace; const editor = root.querySelector('#shared-code'); if (editor && document.activeElement !== editor) editor.value = workspace.code; const status = root.querySelector('#sync-status'); if (status) status.textContent = 'Peer updated the workspace'; });
socket.on('chat-state', messages => { state.chat = messages || []; renderChat(); });
socket.on('chat-message', message => { state.chat.push(message); renderChat(); });
socket.on('peer-left', () => updateConnection('Your peer left the room. They can rejoin.', false));
socket.on('session-ended', () => { endLocalCall(); go('feedback'); });
socket.on('peer-feedback-submitted', () => {
  const button = root.querySelector('#submit');
  if (button?.disabled) button.textContent = 'Peer submitted — finalizing feedback…';
  else toast('Your peer has submitted feedback. Complete yours when ready.');
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
  state.profile = null; state.match = null; state.history = []; state.notifications = []; go('home'); toast('You have been logged out.');
}
document.addEventListener('click', event => { if (event.target.closest('#logout')) logout(); });

function router() {
  const route = location.hash.slice(1) || 'home';
  if (route === 'auth') return window.renderAuthPage();
  const protectedRoutes = ['onboarding', 'search', 'match', 'session', 'feedback', 'dashboard', 'activity'];
  if (protectedRoutes.includes(route) && !localStorage.getItem(EMAIL_KEY)) return window.renderAuthPage();
  const active = readJson('mocksyra-active-match', null);
  if (!state.match && active) { state.match = active; state.roomId = active.roomId; }
  const routes = { onboarding, search, match, session, feedback, dashboard, activity };
  (routes[route] || home)();
  if (localStorage.getItem(EMAIL_KEY)) connectSocket();
}

window.addEventListener('hashchange', router);
async function restoreAuthentication() {
  try {
    const { data } = await window.peerSupabase.auth.getSession();
    const user = data.session?.user;
    if (user?.email && (!state.authenticated || localStorage.getItem(EMAIL_KEY) !== user.email)) {
      state.authenticated = true;
      localStorage.setItem(EMAIL_KEY, user.email);
      router();
    }
  } catch {
    /* Keep the current view usable if Supabase is temporarily unavailable. */
  }
}
router();
restoreAuthentication();
