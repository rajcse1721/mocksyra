/* Run with: node scripts/ui-smoke.cjs
 * Uses local fixture accounts, generated media, and a fake realtime server.
 * No request reaches Supabase, Render, or any other external service.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const project = path.resolve(__dirname, '..');
const artifactDir = path.join(project, 'node_modules', '.cache', 'mocksyra-ui');
const bundledRuntime = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = createRequire(path.join(process.env.MOCKSYRA_PLAYWRIGHT_RUNTIME || bundledRuntime, 'package.json'))('playwright'); }

function fakeSupabaseSDK() {
  window.supabase = {
    createClient() {
      const makeUser = ({ id, email, name, avatar }) => ({
        id,
        email,
        user_metadata: { full_name: `${name} Metadata` },
        identities: [{
          provider: 'google',
          identity_data: { email, full_name: name, avatar_url: avatar }
        }]
      });
      const users = {
        primary: makeUser({ id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.test', name: 'Priya Account', avatar: 'https://fixture-images.example.test/account-avatar.svg' }),
        secondary: makeUser({ id: '00000000-0000-4000-8000-000000000002', email: 'second@example.test', name: 'Sam Second', avatar: 'https://fixture-images.example.test/second-avatar.svg' })
      };
      const listeners = new Set();
      const oauthCallback = new URL(location.href).searchParams.has('code');
      let currentUser = (oauthCallback || localStorage.getItem('mocksyra-email')) ? users.primary : null;
      let currentToken = oauthCallback ? 'google-callback-token' : 'local-fixture-token';
      let deferNextGetSession = false;
      let refreshPlan = { token: 'fixture-recovered-token', error: null };
      let refreshCount = 0;
      let signOutError = null;
      const pendingGetSessions = [];
      const session = () => currentUser ? { user: currentUser, access_token: currentToken } : null;
      const emit = async (event, nextUser = currentUser, accessToken = currentToken) => {
        currentUser = nextUser;
        currentToken = accessToken;
        const nextSession = session();
        window.__fixtureSupabaseAuth.events.push({ event, email: nextUser?.email || null, accessToken });
        await Promise.all([...listeners].map(listener => listener(event, nextSession)));
      };
      window.__fixtureSupabaseAuth = {
        users,
        events: [],
        emit,
        deferNextGetSession() { deferNextGetSession = true; },
        releaseGetSessions() { pendingGetSessions.splice(0).forEach(release => release()); },
        configureRefresh(token, error = null) { refreshPlan = { token, error }; },
        configureSignOutError(message = '') { signOutError = message ? { message, status: 503 } : null; },
        get pendingGetSessionCount() { return pendingGetSessions.length; },
        get refreshCount() { return refreshCount; },
        get currentUser() { return currentUser; },
        get accessToken() { return currentToken; }
      };
      return {
        auth: {
          storageKey: 'sb-fixture-auth-token',
          getSession: () => {
            const result = { data: { session: session() }, error: null };
            if (!deferNextGetSession) return Promise.resolve(result);
            deferNextGetSession = false;
            return new Promise(resolve => pendingGetSessions.push(() => resolve(result)));
          },
          getUser: async () => ({ data: { user: currentUser }, error: null }),
          signInWithPassword: async ({ email }) => {
            currentUser = email === users.primary.email ? users.primary : { ...users.primary, email };
            currentToken = 'local-fixture-token';
            return { data: { session: session() }, error: null };
          },
          signInWithOAuth: async options => { window.__oauthOptions = options; return { data: { provider: 'google' }, error: null }; },
          signUp: async () => ({ data: { session: null }, error: null }),
          refreshSession: async () => {
            refreshCount += 1;
            if (refreshPlan.error) return { data: { session: null }, error: refreshPlan.error };
            await emit('TOKEN_REFRESHED', currentUser, refreshPlan.token || `fixture-recovered-token-${refreshCount}`);
            return { data: { session: session() }, error: null };
          },
          signOut: async () => {
            if (signOutError) return { error: signOutError };
            await emit('SIGNED_OUT', null, '');
            return { error: null };
          },
          onAuthStateChange: callback => {
            listeners.add(callback);
            if (oauthCallback) queueMicrotask(() => emit('SIGNED_IN', users.primary, 'google-callback-token'));
            return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } };
          }
        },
        from: () => ({ upsert: async payload => { window.__savedProfile = payload; return { data: null, error: null }; } })
      };
    }
  };
}

function fakeSocketSDK() {
  window.io = () => {
    const listeners = new Map();
    const accountData = new Map();
    let connectedEmail = '';
      const socket = {
        connected: false,
        active: false,
        auth: {},
      sent: [],
      connectCount: 0,
      disconnectCount: 0,
      sequence: 0,
      ownListings: [],
      activeMatches: [],
        publicListings: null,
        joinedRooms: new Set(),
        rejectedAccessTokens: new Set(),
        rejectAccessToken(token) { socket.rejectedAccessTokens.add(token); },
      on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return socket; },
      once(event, fn) { const once = (...args) => { socket.off(event, once); return fn(...args); }; return socket.on(event, once); },
      off(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); return socket; },
        connect() {
        const nextEmail = window.__fixtureSupabaseAuth?.currentUser?.email || '';
        if (connectedEmail && connectedEmail !== nextEmail) accountData.set(connectedEmail, { profile: socket.profile || null, ownListings: socket.ownListings, activeMatches: socket.activeMatches });
        if (connectedEmail !== nextEmail) {
          const saved = accountData.get(nextEmail) || { profile: null, ownListings: [], activeMatches: [] };
          socket.profile = saved.profile;
          socket.ownListings = [...saved.ownListings];
          socket.activeMatches = [...saved.activeMatches];
          connectedEmail = nextEmail;
        }
          socket.connectCount += 1;
          socket.active = true;
        if (window.__fixtureFailInitialSocketConnect) {
          window.__fixtureFailInitialSocketConnect = false;
          socket.connected = false;
          queueMicrotask(() => socket.receive('connect_error', new Error('Temporary fixture connection failure')));
            return socket;
          }
          if (socket.rejectedAccessTokens.has(socket.auth?.accessToken)) {
            socket.connected = false;
            socket.active = false;
            socket.id = undefined;
            queueMicrotask(() => socket.receive('connect_error', new Error('Authentication required')));
            return socket;
          }
          socket.connected = true;
          socket.id = `fixture-socket-${socket.connectCount}`;
          queueMicrotask(() => socket.receive('connect'));
          return socket;
        },
        disconnect() { socket.disconnectCount += 1; socket.connected = false; socket.active = false; socket.id = undefined; socket.joinedRooms.clear(); return socket; },
      receive(event, payload) {
        if (event === 'match-found' && payload?.roomId) {
          socket.activeMatches = [...socket.activeMatches.filter(item => item.roomId !== payload.roomId), payload];
        }
        if (event === 'match-cancelled' && payload?.roomId) {
          socket.activeMatches = socket.activeMatches.filter(item => item.roomId !== payload.roomId);
        }
        return Promise.all((listeners.get(event) || []).slice().map(fn => fn(payload)));
      },
      emit(event, payload, ack) {
        socket.sent.push({ event, payload });
        if (event === 'restore-profile') {
          queueMicrotask(() => socket.receive('profile-state', {
            profile: socket.profile || null,
            activeMatch: socket.activeMatches[0] || null,
            activeMatches: socket.activeMatches,
            upcomingMatches: socket.activeMatches,
            ownListings: socket.ownListings,
            history: [],
            notifications: []
          }));
          return socket;
        }
        if (event === 'publish-listing') {
          socket.profile = { ...payload, status: 'idle' };
          const additions = (payload.slots || []).map(slot => ({
            ...payload,
            listingId: `self-listing-${++socket.sequence}`,
            slots: [slot],
            status: 'waiting',
            createdAt: new Date().toISOString()
          }));
          socket.ownListings = [...socket.ownListings, ...additions];
          if (typeof ack === 'function') ack({ ok: true, profile: socket.profile, ownListings: socket.ownListings, activeMatches: socket.activeMatches, listings: [], serverNow: new Date().toISOString() });
          return socket;
        }
        if (event === 'browse-listings') {
          if (!socket.publicListings) {
            const slot = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            socket.publicListings = [
              { listingId: 'fixture-interviewer-listing', name: 'Maya Sharma', experience: 'Intermediate', languages: ['Python', 'AWS'], sessionsCompleted: 4, practiceMode: 'interviewer', requiredRole: 'candidate', interviewType: 'System Design', spokenLanguage: 'English', timezone: 'Asia/Kolkata', slots: [slot] },
              { listingId: 'fixture-candidate-listing', name: 'Ravi Mehta', experience: 'Beginner', languages: ['JavaScript', 'React'], sessionsCompleted: 2, practiceMode: 'candidate', requiredRole: 'interviewer', interviewType: 'Frontend', spokenLanguage: 'English + Hindi', timezone: 'Asia/Kolkata', slots: [new Date(Date.now() + 10 * 60 * 1000).toISOString()] }
            ];
          }
          if (typeof ack === 'function') ack({ ok: true, listings: socket.publicListings, ownListings: socket.ownListings, activeMatches: socket.activeMatches, upcomingMatches: socket.activeMatches, serverNow: new Date().toISOString() });
          return socket;
        }
        if (event === 'book-listing') {
          const practiceMode = payload.profile?.practiceMode || 'candidate';
          socket.profile = { ...payload.profile, status: 'idle' };
          const now = Date.now(), activeMatch = { roomId: `fixture-${practiceMode}-${++socket.sequence}`, peer: { name: 'Maya Sharma', experience: 'Intermediate', languages: ['Python', 'AWS'], sessionsCompleted: 4 }, practiceMode, sessionMode: 'directed', peerRole: practiceMode === 'candidate' ? 'interviewer' : 'candidate', durationMinutes: 45, startsAsInterviewer: practiceMode === 'interviewer', initiator: false, score: null, source: 'marketplace', bookingType: 'marketplace', reasons: ['Session selected by you'], sharedSlot: payload.slot || new Date(now + 5 * 60 * 1000).toISOString(), opensAt: new Date(now - 5 * 60 * 1000).toISOString(), closesAt: new Date(now + 20 * 60 * 1000).toISOString(), serverNow: new Date(now).toISOString(), canJoinNow: true, videoProvider: window.__fixtureHostedVideo ? 'daily' : 'webrtc', interviewType: 'System Design', question: { title: 'Build a service', prompt: 'Explain and implement a reliable service.', ...(practiceMode === 'interviewer' ? { hints: ['Fixture interviewer-only hint'] } : {}) }, feedbackCriteria: practiceMode === 'candidate' ? ['Question clarity', 'Guidance', 'Professionalism'] : ['Problem solving', 'Communication', 'Technical depth'], feedbackSubmitted: false, selfFeedback: null, status: 'matched' };
          socket.activeMatches = [...socket.activeMatches, activeMatch];
          socket.publicListings = (socket.publicListings || []).filter(item => item.listingId !== payload.listingId);
          if (typeof ack === 'function') ack({ ok: true, profile: socket.profile, activeMatch, activeMatches: socket.activeMatches, upcomingMatches: socket.activeMatches, ownListings: socket.ownListings });
          return socket;
        }
        if (event === 'cancel-listing') {
          const listingId = typeof payload === 'object' ? payload?.listingId : payload;
          socket.ownListings = socket.ownListings.filter(item => item.listingId !== listingId);
          if (typeof ack === 'function') ack({ ok: true, ownListings: socket.ownListings, activeMatches: socket.activeMatches });
          return socket;
        }
        if (event === 'cancel-search') {
          socket.ownListings = [];
          if (typeof ack === 'function') ack({ ok: true, ownListings: [], activeMatches: socket.activeMatches });
          return socket;
        }
        if (event === 'cancel-match') {
          const roomId = typeof payload === 'object' ? payload?.roomId : payload;
          socket.activeMatches = socket.activeMatches.filter(item => item.roomId !== roomId);
          if (typeof ack === 'function') ack({ ok: true, activeMatches: socket.activeMatches, upcomingMatches: socket.activeMatches, ownListings: socket.ownListings });
          queueMicrotask(() => socket.receive('match-cancelled', { roomId, message: 'This interview was cancelled.' }));
          return socket;
        }
        if (event === 'prepare-call') { if (typeof ack === 'function') ack(window.__fixtureHostedVideo ? { ok: true, provider: 'daily', roomUrl: 'https://fixture.daily.test/private-room', token: 'short-lived-fixture-token' } : { ok: true, provider: 'webrtc' }); return socket; }
        if (event === 'join-session' && window.__fixtureJoinError) {
          const error = window.__fixtureJoinError;
          window.__fixtureJoinError = '';
          if (typeof ack === 'function') ack({ ok: false, error });
          return socket;
        }
        if (event === 'join-session') {
          socket.joinedRooms.add(payload);
          if (typeof ack === 'function') ack({ ok: true, startedAt: new Date().toISOString() });
          return socket;
        }
        if (event === 'leave-session') {
          socket.joinedRooms.delete(typeof payload === 'object' ? payload?.roomId : payload);
          if (typeof ack === 'function') ack({ ok: true });
          return socket;
        }
        if (event === 'workspace-request') queueMicrotask(() => socket.receive('workspace-state', { language: 'JavaScript', code: '// Work together here', version: 0 }));
        if (event === 'workspace-update') queueMicrotask(() => socket.receive('workspace-state', { ...payload, version: 1 }));
        if (event === 'chat-message') queueMicrotask(() => socket.receive('chat-message', { ...payload, id: 'local-message', name: 'Alex Morgan', createdAt: new Date().toISOString() }));
        if (event === 'complete-session') queueMicrotask(() => socket.receive('session-ended', {}));
        if (typeof ack === 'function') ack({ ok: true });
        return socket;
      }
    };
    window.__mocksyraSocket = socket;
    return socket;
  };
}

function fakeDailySDK() {
  window.DailyIframe = { createFrame(container) {
    const listeners = new Map();
    const surface = document.createElement('div'); surface.className = 'daily-fixture-surface'; surface.textContent = 'Hosted video preview'; container.append(surface);
    return {
      on(name, callback) { listeners.set(name, callback); return this; },
      async join(credentials) { window.__dailyJoin = credentials; queueMicrotask(() => listeners.get('joined-meeting')?.()); },
      async leave() { window.__dailyLeaveCount = (window.__dailyLeaveCount || 0) + 1; listeners.get('left-meeting')?.(); },
      destroy() { window.__dailyDestroyCount = (window.__dailyDestroyCount || 0) + 1; surface.remove(); }
    };
  } };
}

function isolateDevices() {
  window.__mediaTracks = [];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = '#174b49'; context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#e5f6f1'; context.font = '600 30px sans-serif'; context.textAlign = 'center';
    context.fillText('Local test preview', 320, 190);
    const stream = canvas.captureStream(1);
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain(); gain.gain.value = 0;
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(gain); gain.connect(destination); oscillator.start();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    window.__mediaTracks = stream.getTracks();
    return stream;
  } });
  window.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; this.remoteDescription = null; }
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'local-test-fixture' }; }
    async createAnswer() { return { type: 'answer', sdp: 'local-test-fixture' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  };
}

function fixtureMatch(practiceMode) {
  return {
    roomId: `fixture-${practiceMode}-123456`,
    peer: { name: 'Maya Sharma', experience: 'Intermediate', languages: ['JavaScript', 'React'], sessionsCompleted: 4 },
    practiceMode,
    sessionMode: 'directed',
    peerRole: practiceMode === 'candidate' ? 'interviewer' : 'candidate',
    durationMinutes: 45,
    startsAsInterviewer: practiceMode === 'interviewer',
    initiator: false,
    score: 100,
    reasons: ['Same interview type', 'Shared JavaScript and React', 'Shared availability'],
    sharedSlot: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    interviewType: 'Frontend',
    question: { title: 'Build a searchable list', prompt: 'Explain and implement filtering a list by a search query.', ...(practiceMode === 'interviewer' ? { hints: ['Fixture interviewer-only hint'] } : {}) },
    feedbackCriteria: practiceMode === 'candidate' ? ['Question clarity', 'Guidance', 'Interview structure'] : ['Problem solving', 'Communication', 'Technical depth'],
    feedbackSubmitted: false,
    selfFeedback: null,
    status: 'matched'
  };
}

const report = { checks: [], screenshots: [], pageErrors: [], blockedRemoteRequests: [], errors: [] };
let origin;
let browser;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((request, response) => {
  const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const target = path.resolve(project, `.${route === '/' ? '/index.html' : route}`);
  if (!target.startsWith(project + path.sep)) { response.writeHead(403); return response.end(); }
  fs.readFile(target, (error, body) => {
    if (error) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(body);
  });
});

async function newPage(authenticated = true, hostedVideo = false, failInitialSocketConnect = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN', reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'https://fixture-images.example.test/account-avatar.svg' || url === 'https://fixture-images.example.test/second-avatar.svg') {
      const initials = url.includes('second-avatar') ? 'SS' : 'PA';
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#2563eb"/><text x="32" y="39" text-anchor="middle" font-size="22" fill="white">${initials}</text></svg>` });
    }
    if (url.includes('cdn.jsdelivr.net/npm/@supabase/')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeSupabaseSDK})();` });
    if (url.includes('cdn.socket.io/') || url.endsWith('/socket.io/socket.io.js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeSocketSDK})();` });
    if (url.includes('@daily-co/daily-js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeDailySDK})();` });
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    report.blockedRemoteRequests.push(url);
    return route.abort();
  });
  await context.addInitScript(isolateDevices);
  await context.addInitScript(value => { window.__fixtureHostedVideo = value; }, hostedVideo);
  await context.addInitScript(value => { window.__fixtureFailInitialSocketConnect = value; }, failInitialSocketConnect);
  await context.addInitScript(loggedIn => { if (loggedIn) localStorage.setItem('mocksyra-email', 'fixture@example.test'); }, authenticated);
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  return page;
}

async function checkOverflow(page, label) {
  const result = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    offenders: [...document.querySelectorAll('body *')].filter(element => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
    }).slice(0, 8).map(element => ({ tag: element.tagName, id: element.id, className: typeof element.className === 'string' ? element.className : '' }))
  }));
  assert.ok(result.width <= result.viewport + 1, `${label}: horizontal overflow ${JSON.stringify(result)}`);
  report.checks.push(`${label}: no horizontal overflow`);
}

async function screenshot(page, name) {
  const target = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
  report.screenshots.push(target);
}

async function verifyGuest() {
  const page = await newPage(false);
  await page.goto(origin); await page.locator('.simple-hero').waitFor();
  assert.match(await page.title(), /Mocksyra/);
  assert.equal(await page.getByText(/Peer Practice/i).count(), 0);
  await screenshot(page, 'landing-desktop'); await checkOverflow(page, 'landing desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, 'landing-mobile'); await checkOverflow(page, 'landing mobile');
  await page.setViewportSize({ width: 320, height: 720 }); await checkOverflow(page, 'landing small mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.simple-hero [data-route="marketplace"]').first().click();
  await page.locator('#auth-email').waitFor();
  await screenshot(page, 'auth-mobile');
  await checkOverflow(page, 'auth mobile');
  await page.setViewportSize({ width: 320, height: 720 });
  await checkOverflow(page, 'auth small mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#auth-submit').click();
  assert.match(await page.locator('#auth-message').innerText(), /email|password/i);
  await page.locator('#sign-up-tab').click();
  assert.match(await page.locator('#auth-submit').innerText(), /create account/i);
  await page.locator('#sign-in-tab').click();
  assert.match(await page.locator('#google-sign-in').innerText(), /Google/);
  await page.locator('#google-sign-in').click();
  const redirectTo = await page.evaluate(() => window.__oauthOptions?.options?.redirectTo);
  assert.equal(new URL(redirectTo).hash, '', 'Google uses a clean callback URL without a router hash');
  await page.locator('#auth-email').fill('fixture@example.test');
  await page.locator('#auth-password').fill('local-fixture-password');
  await page.locator('#auth-submit').click();
  await page.locator('#marketplace-results').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.session-card').length > 0 || document.querySelector('#marketplace-results')?.getAttribute('aria-busy') === 'false');
  const loginState = await page.evaluate(() => ({ cards: document.querySelectorAll('.session-card').length, view: document.querySelector('#app')?.innerText, sent: window.__mocksyraSocket?.sent, email: localStorage.getItem('mocksyra-email') }));
  assert.ok(loginState.cards > 0, `signed-in marketplace did not load listings: ${JSON.stringify(loginState)}`);
  assert.equal((await page.locator('.account-name').innerText()).trim(), 'Priya Account', 'header uses the Google account name');
  assert.equal((await page.locator('.account-email').innerText()).trim(), 'fixture@example.test', 'header shows the signed-in email');
  assert.equal(await page.locator('.account-avatar img').count(), 1, 'header uses the Google account photo');
  assert.equal(await page.locator('.session-card').count(), 2, 'a new account sees every open role without onboarding first');
  await page.evaluate(() => window.__mocksyraSocket.receive('profile-state', {
    profile: { name: 'Booking Alias', practiceMode: 'candidate', languages: ['JavaScript'], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English', timezone: 'Asia/Kolkata', status: 'idle' },
    activeMatch: null,
    activeMatches: [],
    upcomingMatches: [],
    ownListings: [],
    history: [],
    notifications: []
  }));
  assert.equal((await page.locator('.account-name').innerText()).trim(), 'Priya Account', 'a booking alias cannot replace the account name');
  const scheduled = [
    fixtureMatch('candidate'),
    { ...fixtureMatch('interviewer'), roomId: 'fixture-interviewer-second', sharedSlot: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() },
    { ...fixtureMatch('candidate'), roomId: 'fixture-candidate-third', sharedSlot: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString() },
    { ...fixtureMatch('interviewer'), roomId: 'fixture-interviewer-fourth', sharedSlot: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString() }
  ];
  for (const match of scheduled) await page.evaluate(item => window.__mocksyraSocket.receive('match-found', item), match);
  await page.locator('[data-room-id]').first().waitFor();
  assert.equal(await page.locator('[data-room-id]').count(), 4, 'all four upcoming interviews are shown');
  assert.match(await page.locator('#upcoming-schedule').innerText(), /Join now|View booking/i);
  assert.equal(await page.locator('.session-card').count(), 2, 'open listings remain visible below an upcoming interview');
  assert.equal(await page.locator('[data-book-listing]:disabled').count(), 2, 'new bookings are disabled at the four-interview limit');
  const roomsBeforeCancellation = await page.locator('[data-room-id]').evaluateAll(cards => cards.map(card => card.dataset.roomId));
  const cancelledRoomId = roomsBeforeCancellation[2];
  await page.locator('[data-cancel-match]').nth(2).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-room-id]').length === 3);
  assert.equal(await page.locator('[data-room-id]').count(), 3, 'cancelling one interview keeps the other bookings');
  const roomsAfterCancellation = await page.locator('[data-room-id]').evaluateAll(cards => cards.map(card => card.dataset.roomId));
  assert.equal(roomsAfterCancellation.includes(cancelledRoomId), false, 'the selected interview card is the one removed');
  assert.deepEqual(new Set(roomsAfterCancellation), new Set(roomsBeforeCancellation.filter(roomId => roomId !== cancelledRoomId)));
  assert.equal(await page.locator('[data-book-listing]:disabled').count(), 0, 'booking becomes available again after cancellation');
  await screenshot(page, 'sessions-upcoming-mobile');
  await checkOverflow(page, 'multiple schedule mobile');
  const openedRoomId = await page.locator('[data-open-match]').nth(1).getAttribute('data-open-match');
  await page.locator('[data-open-match]').nth(1).click();
  await page.locator('#join').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mocksyra-active-match')).roomId), openedRoomId, 'opening a schedule card selects that exact room');
  report.checks.push('Simple auth, Google identity header, multiple private bookings, and targeted cancellation');
  await page.context().close();
}

async function verifyGoogleCallback() {
  const page = await newPage(false);
  await page.goto(`${origin}/?code=fixture-google-callback`);
  await page.waitForURL('**/#marketplace');
  await page.locator('.session-card').first().waitFor();
  const callbackState = await page.evaluate(() => ({
    email: localStorage.getItem('mocksyra-email'),
    route: location.hash,
    search: location.search,
    token: window.__mocksyraAccessToken,
    socketToken: window.__mocksyraSocket.auth.accessToken,
    events: window.__fixtureSupabaseAuth.events
  }));
  assert.equal(callbackState.email, 'fixture@example.test', 'Google callback stores the authenticated account');
  assert.equal(callbackState.route, '#marketplace', 'Google callback opens the sessions board');
  assert.equal(callbackState.search, '', 'the one-time OAuth code is removed from the browser URL');
  assert.equal(callbackState.token, 'google-callback-token');
  assert.equal(callbackState.socketToken, 'google-callback-token');
  assert.equal(callbackState.events.some(item => item.event === 'SIGNED_IN' && item.email === 'fixture@example.test'), true, 'the SDK callback completes through onAuthStateChange');
  assert.equal((await page.locator('.account-name').innerText()).trim(), 'Priya Account');
  await page.evaluate(() => { location.hash = 'onboarding'; });
  await page.locator('#name').waitFor();
  await page.locator('#name').fill('OAuth form must survive refresh');
  await page.evaluate(() => { window.__oauthRefreshInput = document.querySelector('#name'); });
  await page.evaluate(() => window.__fixtureSupabaseAuth.emit('TOKEN_REFRESHED', window.__fixtureSupabaseAuth.users.primary, 'oauth-refreshed-token'));
  await page.waitForFunction(() => window.__mocksyraSocket.auth.accessToken === 'oauth-refreshed-token');
  const refreshedCallback = await page.evaluate(() => ({
    route: location.hash,
    sameInput: window.__oauthRefreshInput === document.querySelector('#name'),
    value: document.querySelector('#name')?.value
  }));
  assert.equal(refreshedCallback.route, '#onboarding', 'a later token refresh does not replay the one-time OAuth redirect');
  assert.equal(refreshedCallback.sameInput, true, 'OAuth token refresh does not rerender the active page');
  assert.equal(refreshedCallback.value, 'OAuth form must survive refresh');
  report.checks.push('Google OAuth callback is consumed once; later token refreshes preserve the active page');
  await page.context().close();
}

async function verifyRealtimeRecovery() {
  const page = await newPage(true, false, true);
  await page.goto(`${origin}/#marketplace`);
  await page.waitForFunction(() => window.__mocksyraSocket?.connectCount >= 1 && !window.__mocksyraSocket.connected && document.querySelector('#marketplace-results')?.getAttribute('aria-busy') === 'false');
  const beforeRecovery = await page.evaluate(() => ({
    disconnects: window.__mocksyraSocket.disconnectCount,
    restores: window.__mocksyraSocket.sent.filter(item => item.event === 'restore-profile').length
  }));
  const recovered = await page.evaluate(async () => {
    const socket = window.__mocksyraSocket;
    socket.connected = true;
    socket.active = true;
    await socket.receive('connect');
    await new Promise(resolve => queueMicrotask(resolve));
    return {
      connected: socket.connected,
      active: socket.active,
      disconnects: socket.disconnectCount,
      restores: socket.sent.filter(item => item.event === 'restore-profile').length
    };
  });
  assert.equal(recovered.connected, true, 'Socket.IO automatic recovery is accepted after a transient first failure');
  assert.equal(recovered.active, true);
  assert.equal(recovered.disconnects, beforeRecovery.disconnects, 'the recovered authenticated socket is not immediately disconnected');
  assert.equal(recovered.restores, beforeRecovery.restores + 1, 'automatic recovery restores the account schedule');
  report.checks.push('A verified socket identity survives a transient first connection failure and automatic reconnect');
  await page.context().close();
}

async function verifyAuthHandshakeRecovery() {
  const recoveredPage = await newPage();
  await recoveredPage.goto(`${origin}/#marketplace`);
  await recoveredPage.waitForFunction(() => window.__mocksyraSocket?.connected);
  await recoveredPage.evaluate(() => {
    window.__fixtureSupabaseAuth.configureRefresh('valid-recovered-token');
    window.__mocksyraSocket.rejectAccessToken('local-fixture-token');
    window.__mocksyraSocket.disconnect();
    window.connectMocksyraSocket();
  });
  await recoveredPage.waitForFunction(() => window.__mocksyraSocket.connected && window.__mocksyraSocket.auth.accessToken === 'valid-recovered-token');
  const recovered = await recoveredPage.evaluate(() => ({
    route: location.hash,
    refreshes: window.__fixtureSupabaseAuth.refreshCount,
    email: localStorage.getItem('mocksyra-email'),
    accountKey: localStorage.getItem('mocksyra-account-key')
  }));
  assert.equal(recovered.route, '#marketplace');
  assert.equal(recovered.refreshes, 1, 'an expired handshake performs one bounded token refresh');
  assert.equal(recovered.email, 'fixture@example.test');
  assert.match(recovered.accountKey, /fixture@example\.test$/);
  await recoveredPage.evaluate(() => { location.hash = 'auth'; });
  await recoveredPage.locator('#auth-form').waitFor();
  await recoveredPage.evaluate(() => window.__fixtureSupabaseAuth.emit('TOKEN_REFRESHED', window.__fixtureSupabaseAuth.users.primary, 'background-refreshed-token'));
  await recoveredPage.waitForURL('**/#marketplace');
  assert.equal(await recoveredPage.evaluate(() => window.__mocksyraSocket.auth.accessToken), 'background-refreshed-token', 'a valid background refresh exits the sign-in screen without losing the account');
  await recoveredPage.context().close();

  const rejectedPage = await newPage();
  await rejectedPage.goto(`${origin}/#marketplace`);
  await rejectedPage.waitForFunction(() => window.__mocksyraSocket?.connected);
  await rejectedPage.evaluate(() => {
    const profile = { email: 'fixture@example.test', name: 'Private alias', practiceMode: 'candidate' };
    const match = { ...window.__mocksyraSocket.activeMatches[0], roomId: 'private-room' };
    localStorage.setItem('mocksyra-profile', JSON.stringify(profile));
    localStorage.setItem('mocksyra-active-match', JSON.stringify(match));
    localStorage.setItem('mocksyra-active-matches', JSON.stringify([match]));
    window.__fixtureSupabaseAuth.configureRefresh('also-rejected-token');
    window.__mocksyraSocket.rejectAccessToken('local-fixture-token');
    window.__mocksyraSocket.rejectAccessToken('also-rejected-token');
    window.__mocksyraSocket.disconnect();
    window.connectMocksyraSocket();
  });
  await rejectedPage.waitForURL('**/#auth');
  await rejectedPage.waitForFunction(() => !window.__mocksyraSocket.connected);
  const rejected = await rejectedPage.evaluate(() => ({
    refreshes: window.__fixtureSupabaseAuth.refreshCount,
    email: localStorage.getItem('mocksyra-email'),
    accountKey: localStorage.getItem('mocksyra-account-key'),
    profile: localStorage.getItem('mocksyra-profile'),
    match: localStorage.getItem('mocksyra-active-match'),
    matches: localStorage.getItem('mocksyra-active-matches')
  }));
  assert.equal(rejected.refreshes, 1, 'a rejected refreshed token is not refreshed in an infinite loop');
  assert.deepEqual({ email: rejected.email, accountKey: rejected.accountKey, profile: rejected.profile, match: rejected.match, matches: rejected.matches }, { email: null, accountKey: null, profile: null, match: null, matches: null }, 'invalid authentication clears all private account state');
  report.checks.push('Authentication-required handshakes refresh once, recover valid sessions, and terminate invalid sessions without loops');
  await rejectedPage.context().close();
}

async function verifyLogoutFailure() {
  const page = await newPage();
  await page.goto(`${origin}/#marketplace`);
  await page.waitForFunction(() => window.__mocksyraSocket?.connected);
  await page.evaluate(() => {
    localStorage.setItem('sb-fixture-auth-token', JSON.stringify({ access_token: 'private-token' }));
    localStorage.setItem('mocksyra-profile', JSON.stringify({ email: 'fixture@example.test', name: 'Private alias' }));
    localStorage.setItem('mocksyra-active-matches', JSON.stringify([{ roomId: 'private-room' }]));
    window.__fixtureSupabaseAuth.configureSignOutError('Fixture sign-out network failure');
  });
  await page.locator('#logout').click();
  await page.waitForURL('**/#home');
  const result = await page.evaluate(() => ({
    authStorage: localStorage.getItem('sb-fixture-auth-token'),
    email: localStorage.getItem('mocksyra-email'),
    accountKey: localStorage.getItem('mocksyra-account-key'),
    profile: localStorage.getItem('mocksyra-profile'),
    matches: localStorage.getItem('mocksyra-active-matches'),
    toast: [...document.querySelectorAll('.toast')].at(-1)?.textContent || ''
  }));
  assert.deepEqual({ authStorage: result.authStorage, email: result.email, accountKey: result.accountKey, profile: result.profile, matches: result.matches }, { authStorage: null, email: null, accountKey: null, profile: null, matches: null }, 'a resolved sign-out error still clears the local Supabase session and private app state');
  assert.match(result.toast, /logged out on this device/i);
  report.checks.push('Resolved Supabase sign-out errors still produce a durable local logout');
  await page.context().close();
}

async function verifyAuthLifecycle() {
  const page = await newPage();
  await page.goto(`${origin}/#onboarding`);
  await page.locator('#name').waitFor();
  await page.waitForFunction(() => window.__mocksyraSocket?.connected);
  await page.locator('#name').fill('Unsaved booking alias');
  const beforeRefresh = await page.evaluate(() => {
    window.__fixtureNameInput = document.querySelector('#name');
    return { connects: window.__mocksyraSocket.connectCount, disconnects: window.__mocksyraSocket.disconnectCount };
  });
  await page.evaluate(() => window.__fixtureSupabaseAuth.emit('TOKEN_REFRESHED', window.__fixtureSupabaseAuth.users.primary, 'refreshed-fixture-token'));
  await page.waitForFunction(() => window.__mocksyraSocket.auth.accessToken === 'refreshed-fixture-token');
  const afterRefresh = await page.evaluate(() => ({
    connects: window.__mocksyraSocket.connectCount,
    disconnects: window.__mocksyraSocket.disconnectCount,
    sameInput: window.__fixtureNameInput === document.querySelector('#name'),
    value: document.querySelector('#name')?.value,
    route: location.hash
  }));
  assert.deepEqual({ connects: afterRefresh.connects, disconnects: afterRefresh.disconnects }, beforeRefresh, 'a token refresh does not reconnect the active socket');
  assert.equal(afterRefresh.sameInput, true, 'a token refresh does not rerender the active form');
  assert.equal(afterRefresh.value, 'Unsaved booking alias', 'a token refresh preserves unsaved form input');
  assert.equal(afterRefresh.route, '#onboarding');

  await page.evaluate(() => { location.hash = 'marketplace'; });
  await page.locator('#upcoming-schedule').waitFor();
  const oldMatch = fixtureMatch('candidate');
  const oldOffer = {
    listingId: 'old-account-offer',
    name: 'Old booking alias',
    practiceMode: 'candidate',
    interviewType: 'Frontend',
    experience: 'Intermediate',
    languages: ['JavaScript'],
    spokenLanguage: 'English',
    timezone: 'Asia/Kolkata',
    slots: [new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()],
    status: 'waiting'
  };
  await page.evaluate(({ match, offer }) => {
    const profile = { ...offer, email: 'fixture@example.test', status: 'idle' };
    window.__mocksyraSocket.profile = profile;
    window.__mocksyraSocket.activeMatches = [match];
    window.__mocksyraSocket.ownListings = [offer];
    return window.__mocksyraSocket.receive('profile-state', {
      profile,
      activeMatch: match,
      activeMatches: [match],
      upcomingMatches: [match],
      ownListings: [offer],
      history: [],
      notifications: []
    });
  }, { match: oldMatch, offer: oldOffer });
  await page.waitForFunction(() => document.querySelectorAll('[data-room-id]').length === 1 && document.querySelectorAll('[data-own-listing-id]').length === 1);
  await page.evaluate(() => {
    window.__mocksyraSocket.disconnect();
    window.__fixtureSupabaseAuth.deferNextGetSession();
    window.__staleConnectPromise = window.connectMocksyraSocket();
  });
  await page.waitForFunction(() => window.__fixtureSupabaseAuth.pendingGetSessionCount === 1);
  const beforeSwitch = await page.evaluate(() => ({ connects: window.__mocksyraSocket.connectCount, disconnects: window.__mocksyraSocket.disconnectCount }));
  await page.evaluate(() => window.__fixtureSupabaseAuth.emit('SIGNED_IN', window.__fixtureSupabaseAuth.users.secondary, 'second-account-token'));
  await page.waitForFunction(() => document.querySelector('.account-email')?.textContent.trim() === 'second@example.test' && window.__mocksyraSocket.connected && window.__mocksyraSocket.auth.accessToken === 'second-account-token');
  const restoreCountBeforeStaleSession = await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'restore-profile').length);
  const staleConnectionResult = await page.evaluate(async () => {
    window.__fixtureSupabaseAuth.releaseGetSessions();
    return window.__staleConnectPromise;
  });
  await page.waitForTimeout(0);
  const switched = await page.evaluate(() => ({
    connects: window.__mocksyraSocket.connectCount,
    disconnects: window.__mocksyraSocket.disconnectCount,
    profile: localStorage.getItem('mocksyra-profile'),
    selectedMatch: localStorage.getItem('mocksyra-active-match'),
    matches: JSON.parse(localStorage.getItem('mocksyra-active-matches') || '[]'),
    accountKey: localStorage.getItem('mocksyra-account-key'),
    currentEmail: window.__fixtureSupabaseAuth.currentUser.email,
    socketToken: window.__mocksyraSocket.auth.accessToken,
    restores: window.__mocksyraSocket.sent.filter(item => item.event === 'restore-profile').length
  }));
  assert.equal(staleConnectionResult, false, 'an old account connection waiting on getSession is invalidated');
  assert.equal(switched.disconnects, beforeSwitch.disconnects + 1, 'changing accounts disconnects the prior authenticated socket');
  assert.equal(switched.connects, beforeSwitch.connects + 1, 'changing accounts reconnects with the new identity');
  assert.equal(switched.profile, null, 'changing accounts clears the previous booking profile cache');
  assert.equal(switched.selectedMatch, null, 'changing accounts clears the previously selected interview');
  assert.deepEqual(switched.matches, [], 'changing accounts clears the previous schedule');
  assert.equal(switched.accountKey, '00000000-0000-4000-8000-000000000002:second@example.test');
  assert.equal(switched.currentEmail, 'second@example.test');
  assert.equal(switched.socketToken, 'second-account-token', 'the delayed old session cannot replace the new socket token');
  assert.equal(switched.restores, restoreCountBeforeStaleSession, 'the delayed old session cannot send another profile restore');
  assert.equal((await page.locator('.account-name').innerText()).trim(), 'Sam Second');
  assert.equal(await page.locator('[data-room-id]').count(), 0, 'the next account cannot see the prior account bookings');
  assert.equal(await page.locator('[data-own-listing-id]').count(), 0, 'the next account cannot see the prior account offers');
  report.checks.push('Token refresh preserves in-progress UI, while account switching cancels delayed old connections and clears private state');
  await page.context().close();
}

async function verifyRejectedWebRtcAdmission() {
  const page = await newPage();
  await page.goto(`${origin}/#onboarding`);
  await page.locator('#name').waitFor();
  await page.locator('#name').fill('WebRTC Test');
  await page.locator('#publish').click();
  await page.waitForURL('**/#marketplace');
  await page.locator('[data-book-role="candidate"]').first().click();
  const roomId = await page.locator('[data-open-match]').first().getAttribute('data-open-match');
  await page.locator('[data-open-match]').first().click();
  await page.evaluate(() => { window.__fixtureJoinError = 'This interview is no longer available.'; });
  await page.locator('#join').click();
  await page.waitForURL('**/#match');
  const rejected = await page.evaluate(expectedRoomId => ({
    tracksStopped: window.__mediaTracks.length > 0 && window.__mediaTracks.every(track => track.readyState === 'ended'),
    joinedRooms: [...window.__mocksyraSocket.joinedRooms],
    leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').map(item => item.payload),
    hasLiveTimer: Boolean(document.querySelector('#side-timer'))
  }), roomId);
  assert.equal(rejected.tracksStopped, true, 'rejected WebRTC admission stops all captured media');
  assert.deepEqual(rejected.joinedRooms, [], 'rejected WebRTC admission never remains in a socket room');
  assert.equal(rejected.leaves.at(-1), roomId, 'rejected admission defensively leaves only the requested room');
  assert.equal(rejected.hasLiveTimer, false, 'rejected admission returns to the booking screen');
  report.checks.push('Rejected WebRTC admission stops capture and leaves the exact attempted room');
  await page.context().close();
}

async function verifyMode(practiceMode) {
  const page = await newPage();
  await page.goto(`${origin}/#onboarding`); await page.locator('#name').waitFor();
  assert.equal(await page.locator('[data-mode="peer"]').count(), 0);
  await page.locator(`[data-mode="${practiceMode}"]`).click();
  assert.equal(await page.locator(`[data-mode="${practiceMode}"]`).getAttribute('aria-pressed'), 'true');
  await page.locator('#name').fill('');
  await page.locator('#publish').click();
  assert.equal(await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'publish-listing').length), 0, 'Incomplete preferences cannot publish');
  await page.locator('#name').fill('Alex Morgan');
  await page.locator('#interview-type').selectOption('Frontend');
  await page.locator('#technology').selectOption('JavaScript');
  assert.equal(await page.locator('#session-date').getAttribute('type'), 'date');
  assert.equal(await page.locator('#session-time').getAttribute('type'), 'time');
  const selectedDate = await page.evaluate(() => {
    const value = new Date(); value.setDate(value.getDate() + 7);
    const pad = part => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  });
  await page.locator('#session-date').fill(selectedDate);
  await page.locator('#session-time').fill('13:15');
  if (practiceMode === 'candidate') {
    await screenshot(page, 'onboarding-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await checkOverflow(page, 'onboarding mobile'); await screenshot(page, 'onboarding-mobile');
    await page.setViewportSize({ width: 320, height: 720 }); await checkOverflow(page, 'onboarding small mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.locator('#publish').click();
  await page.waitForFunction(() => window.__mocksyraSocket.sent.some(item => item.event === 'publish-listing'));
  const submitted = await page.evaluate(() => window.__mocksyraSocket.sent.find(item => item.event === 'publish-listing').payload);
  assert.equal(submitted.practiceMode, practiceMode);
  assert.deepEqual(submitted.languages, ['JavaScript']);
  assert.equal(submitted.slots.length, 1);
  const submittedLocal = await page.evaluate(iso => {
    const value = new Date(iso), pad = part => String(part).padStart(2, '0');
    return { date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`, time: `${pad(value.getHours())}:${pad(value.getMinutes())}` };
  }, submitted.slots[0]);
  assert.deepEqual(submittedLocal, { date: selectedDate, time: '13:15' }, 'the date and time picker submits the chosen local time');
  await page.waitForURL('**/#marketplace');
  await page.locator('.session-card').first().waitFor();
  const chosenDateLabel = await page.evaluate(iso => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), submitted.slots[0]);
  assert.match(await page.locator('[data-own-listing-id]').first().innerText(), new RegExp(chosenDateLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'the chosen date appears on the published offer');
  assert.match(await page.locator('#marketplace-results').innerText(), /Python|AWS/);
  assert.match(await page.locator('#marketplace-results').innerText(), /Interviewer available/i);
  assert.match(await page.locator('#marketplace-results').innerText(), /Candidate looking/i);
  assert.equal(await page.locator('.session-card').getByText(/Join room/i).count(), 0, 'public listing never exposes Join');
  assert.equal((await page.locator('.account-name').innerText()).trim(), 'Priya Account', 'booking alias never replaces the account name');
  assert.equal((await page.locator('.account-email').innerText()).trim(), 'fixture@example.test');
  if (practiceMode === 'candidate') {
    await page.locator('[data-create-role="interviewer"]').last().click();
    await page.locator('#session-date').waitFor();
    const secondDate = await page.evaluate(() => {
      const value = new Date(); value.setDate(value.getDate() + 9);
      const pad = part => String(part).padStart(2, '0');
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    });
    await page.locator('#session-date').fill(secondDate);
    await page.locator('#session-time').fill('15:30');
    await page.locator('#publish').click();
    await page.waitForURL('**/#marketplace');
    await page.waitForFunction(() => document.querySelectorAll('[data-own-listing-id]').length === 2);
    assert.equal(await page.locator('[data-own-listing-id]').count(), 2, 'multiple published offers are shown');
    await page.locator('[data-cancel-listing]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-own-listing-id]').length === 1);
    assert.equal(await page.locator('[data-own-listing-id]').count(), 1, 'cancelling one offer preserves the other');
  }
  if (practiceMode === 'candidate') {
    await screenshot(page, 'marketplace-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await checkOverflow(page, 'marketplace mobile'); await screenshot(page, 'marketplace-mobile');
    await page.setViewportSize({ width: 320, height: 720 }); await checkOverflow(page, 'marketplace small mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.locator(`[data-book-role="${practiceMode}"]`).first().click();
  const match = fixtureMatch(practiceMode); match.durationMinutes = 45;
  await page.waitForFunction(() => document.querySelectorAll('.session-card').length === 1);
  assert.equal(await page.locator('.session-card').count(), 1, 'the booked public listing is removed from the board');
  const bookedRoomId = await page.locator('[data-open-match]').first().getAttribute('data-open-match');
  await page.locator('[data-open-match]').first().click();
  await page.locator('#join').waitFor();
  assert.match(await page.locator('#app').innerText(), new RegExp(`${match.durationMinutes}`));
  const calendarDownload = page.waitForEvent('download');
  await page.locator('#calendar').click();
  const calendar = fs.readFileSync(await (await calendarDownload).path(), 'utf8');
  const parseCalendarTime = value => {
    const parts = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/).slice(1).map(Number);
    return Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2));
  };
  assert.equal((parseCalendarTime(calendar.match(/DTEND:(\S+)/)[1]) - parseCalendarTime(calendar.match(/DTSTART:(\S+)/)[1])) / 60000, match.durationMinutes);
  const unfoldedCalendar = calendar.replace(/\r\n[ \t]/g, '');
  assert.equal(unfoldedCalendar.includes(`URL:${origin}/#match?room=${encodeURIComponent(bookedRoomId)}`), true, 'calendar invite opens the exact booked room');
  await page.locator('#test-devices').click();
  await page.waitForFunction(() => document.querySelector('#device-preview')?.srcObject?.active);
  if (practiceMode === 'candidate') {
    const leavesBeforeDeviceExit = await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length);
    await page.locator('.app-sections [data-route="marketplace"]').click();
    await page.locator(`[data-open-match="${bookedRoomId}"]`).waitFor();
    assert.equal(await page.evaluate(() => window.__mediaTracks.every(track => track.readyState === 'ended')), true, 'leaving the booking page stops device-test media');
    assert.equal(await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length), leavesBeforeDeviceExit, 'device preview cleanup does not leave a room that was never joined');
    await page.locator(`[data-open-match="${bookedRoomId}"]`).click();
    await page.locator('#join').waitFor();
  }
  await page.locator('#join').click();
  await page.locator('#side-timer').waitFor();
  assert.match(await page.locator('#side-timer').innerText(), new RegExp(`^${match.durationMinutes}:00$`));
  const ready = {
    startedAt: new Date().toISOString(), serverNow: new Date().toISOString(),
    role: practiceMode === 'interviewer' ? 'interviewer' : 'candidate', phase: 1,
    question: match.question, durationMinutes: match.durationMinutes
  };
  await page.evaluate(packet => window.__mocksyraSocket.receive('session-ready', packet), ready);
  const microphone = page.locator('#mic');
  await microphone.click();
  assert.equal(await page.evaluate(() => window.__mediaTracks.find(track => track.kind === 'audio').enabled), false);
  await microphone.click();
  assert.equal(await page.evaluate(() => window.__mediaTracks.find(track => track.kind === 'audio').enabled), true);
  if (practiceMode === 'candidate') {
    const beforeReconnect = await page.evaluate(() => ({
      joins: window.__mocksyraSocket.sent.filter(item => item.event === 'join-session').length,
      workspaceRequests: window.__mocksyraSocket.sent.filter(item => item.event === 'workspace-request').length
    }));
    await page.evaluate(() => { window.__mocksyraSocket.disconnect(); window.__mocksyraSocket.connect(); });
    await page.waitForFunction(({ joins, roomId }) => window.__mocksyraSocket.connected && window.__mocksyraSocket.joinedRooms.has(roomId) && window.__mocksyraSocket.sent.filter(item => item.event === 'join-session').length === joins + 1, { joins: beforeReconnect.joins, roomId: bookedRoomId });
    const reconnected = await page.evaluate(() => ({
      joins: window.__mocksyraSocket.sent.filter(item => item.event === 'join-session'),
      workspaceRequests: window.__mocksyraSocket.sent.filter(item => item.event === 'workspace-request').length,
      joinedRooms: [...window.__mocksyraSocket.joinedRooms]
    }));
    assert.equal(reconnected.joins.at(-1).payload, bookedRoomId, 'a live reconnect rejoins the exact captured room');
    assert.equal(reconnected.workspaceRequests, beforeReconnect.workspaceRequests + 1, 'a live reconnect restores workspace synchronization');
    assert.deepEqual(reconnected.joinedRooms, [bookedRoomId]);
  }
  if (practiceMode === 'candidate') {
    const leavesBeforeSessionExit = await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length);
    await page.locator('[data-tab="workspace-panel"]').click();
    await page.locator('#shared-code').fill('stale debounce must not cross rooms');
    await page.locator('.app-sections [data-route="marketplace"]').click();
    await page.locator(`[data-open-match="${bookedRoomId}"]`).waitFor();
    await page.waitForTimeout(180);
    const exited = await page.evaluate(() => ({
      leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session'),
      staleWorkspaceWrites: window.__mocksyraSocket.sent.filter(item => item.event === 'workspace-update' && item.payload?.code === 'stale debounce must not cross rooms').length,
      tracksStopped: window.__mediaTracks.every(track => track.readyState === 'ended')
    }));
    assert.equal(exited.leaves.length, leavesBeforeSessionExit + 1, 'leaving a live session leaves exactly one socket room');
    assert.equal(exited.leaves.at(-1).payload, bookedRoomId, 'live-session cleanup leaves the originally joined room');
    assert.equal(exited.staleWorkspaceWrites, 0, 'a pending workspace debounce is discarded after leaving the room');
    assert.equal(exited.tracksStopped, true, 'leaving a live session stops all local media tracks');
    await page.locator(`[data-open-match="${bookedRoomId}"]`).click();
    await page.locator('#join').click();
    await page.locator('#side-timer').waitFor();
    await page.evaluate(packet => window.__mocksyraSocket.receive('session-ready', packet), { ...ready, roomId: bookedRoomId });
    await screenshot(page, 'session-candidate-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await checkOverflow(page, 'candidate session mobile'); await screenshot(page, 'session-candidate-mobile');
    await page.setViewportSize({ width: 320, height: 720 }); await checkOverflow(page, 'candidate session small mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.locator('[data-tab="workspace-panel"]').click();
  assert.equal(await page.locator('#workspace-panel').isVisible(), true);
  if (practiceMode === 'interviewer') assert.match(await page.locator('#workspace-panel').innerText(), /Fixture interviewer-only hint|Hints for the interviewer/);
  else assert.equal(await page.locator('#workspace-panel').getByText('Fixture interviewer-only hint').count(), 0);
  await page.locator('#shared-code').fill('console.log(6 * 7);');
  await page.locator('#run-code').click();
  await page.waitForFunction(() => document.querySelector('#code-output').textContent.trim() === '42');
  await page.waitForFunction(() => window.__mocksyraSocket.sent.some(item => item.event === 'workspace-update' && item.payload.code.includes('6 * 7')));
  await page.locator('[data-tab="video-panel"]').click();
  const leavesBeforeCompletion = await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length);
  await page.locator('#complete').click();
  await page.locator('#submit').waitFor();
  const completedRoomCleanup = await page.evaluate(() => ({
    leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session'),
    joinedRooms: [...window.__mocksyraSocket.joinedRooms]
  }));
  assert.equal(completedRoomCleanup.leaves.length, leavesBeforeCompletion + 1, 'completion leaves one exact socket room');
  assert.equal(completedRoomCleanup.leaves.at(-1).payload, bookedRoomId);
  assert.equal(completedRoomCleanup.joinedRooms.includes(bookedRoomId), false, 'completed room membership is removed before feedback');
  const feedbackText = await page.locator('.feedback-card').innerText();
  if (practiceMode === 'candidate') assert.match(feedbackText, /Question clarity/i);
  else assert.match(feedbackText, /Problem solving/i);
  await page.locator('#submit').click();
  assert.equal(await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'submit-feedback').length), 0);
  for (const row of await page.locator('.rating-row').all()) await row.locator('[data-score="4"]').click();
  await page.locator('#strength').fill('Clear explanations and good reasoning throughout.');
  await page.locator('#improve').fill('Please summarize the time complexity before coding.');
  await page.locator('[data-repeat="yes"]').click();
  await page.locator('#submit').click();
  assert.equal(await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'submit-feedback').length), 1);
  report.checks.push(`${practiceMode}: publishes availability, sees the complementary role, books a private 45-minute session, then reaches video, shared workspace and feedback`);
  await page.context().close();
}

async function verifyHostedVideo() {
  const page = await newPage(true, true);
  await page.goto(`${origin}/#onboarding`); await page.locator('#name').waitFor();
  await page.locator('[data-mode="candidate"]').click();
  await page.locator('#name').fill('Alex Morgan');
  await page.locator('#interview-type').selectOption('Frontend');
  await page.locator('#technology').selectOption('JavaScript');
  await page.locator('#publish').click();
  await page.locator('.session-card').first().waitFor();
  await page.locator('[data-book-role="candidate"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.session-card').length === 1);
  const bookedRoomId = await page.locator('[data-open-match]').first().getAttribute('data-open-match');
  await page.locator('[data-open-match]').first().click();
  await page.locator('#join').click();
  await page.waitForFunction(() => Boolean(window.__dailyJoin));
  assert.equal(await page.evaluate(() => window.__dailyJoin.url), 'https://fixture.daily.test/private-room');
  assert.equal(await page.evaluate(() => [...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index))).some(value => value?.includes('short-lived-fixture-token'))), false, 'Daily token is never persisted');
  assert.equal(await page.locator('#local').count(), 0, 'Daily owns camera and microphone capture');
  assert.match(await page.locator('#daily-status').innerText(), /connected/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkOverflow(page, 'hosted video mobile'); await screenshot(page, 'session-daily-mobile');
  const leavesBeforeExit = await page.evaluate(() => window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length);
  await page.locator('.app-sections [data-route="marketplace"]').click();
  await page.locator('#upcoming-schedule').waitFor();
  await page.waitForFunction(() => (window.__dailyLeaveCount || 0) > 0 && (window.__dailyDestroyCount || 0) > 0);
  const hostedExit = await page.evaluate(() => ({
    leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session'),
    dailyLeaves: window.__dailyLeaveCount,
    dailyDestroys: window.__dailyDestroyCount
  }));
  assert.equal(hostedExit.leaves.length, leavesBeforeExit + 1, 'leaving hosted video leaves exactly one socket room');
  assert.equal(hostedExit.leaves.at(-1).payload, bookedRoomId, 'hosted video cleanup leaves the captured room');
  assert.ok(hostedExit.dailyLeaves >= 1 && hostedExit.dailyDestroys >= 1, 'leaving the session stops and destroys Daily media');
  await page.locator(`[data-open-match="${bookedRoomId}"]`).click();
  await page.locator('#join').waitFor();
  const beforeRejectedJoin = await page.evaluate(() => ({
    leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length,
    dailyLeaves: window.__dailyLeaveCount || 0,
    dailyDestroys: window.__dailyDestroyCount || 0
  }));
  await page.evaluate(() => { window.__fixtureJoinError = 'Finish your current live interview before joining another room.'; });
  await page.locator('#join').click();
  await page.waitForFunction(previous => (window.__dailyLeaveCount || 0) > previous, beforeRejectedJoin.dailyLeaves);
  const rejectedJoin = await page.evaluate(() => ({
    route: location.hash,
    status: document.querySelector('#daily-status')?.textContent,
    surfaces: document.querySelectorAll('.daily-fixture-surface').length,
    leaves: window.__mocksyraSocket.sent.filter(item => item.event === 'leave-session').length,
    dailyLeaves: window.__dailyLeaveCount || 0,
    dailyDestroys: window.__dailyDestroyCount || 0
  }));
  assert.equal(rejectedJoin.route, '#session');
  assert.match(rejectedJoin.status, /finish your current live interview/i);
  assert.equal(rejectedJoin.surfaces, 0, 'a rejected backend admission destroys the Daily surface');
  assert.equal(rejectedJoin.leaves, beforeRejectedJoin.leaves + 1, 'a timed-out or rejected admission defensively leaves the socket room');
  assert.ok(rejectedJoin.dailyLeaves > beforeRejectedJoin.dailyLeaves && rejectedJoin.dailyDestroys > beforeRejectedJoin.dailyDestroys, 'a rejected backend admission releases Daily media');
  report.checks.push('Daily Prebuilt uses short-lived credentials and releases both Daily and socket rooms on navigation or rejected admission');
  await page.context().close();
}

async function verifyHistory() {
  const page = await newPage();
  await page.goto(`${origin}/#activity`);
  await page.locator('.history-list').waitFor();
  const history = ['candidate', 'interviewer'].map(mode => ({
    ...fixtureMatch(mode), completedAt: new Date().toISOString(),
    feedbackReceived: { scores: [4, 5, 4], strength: 'Clear reasoning.', improve: 'Practice edge cases.' }
  }));
  await page.evaluate(packet => window.__mocksyraSocket.receive('history', packet), history);
  assert.equal(await page.locator('.history-card').count(), 2);
  assert.match(await page.locator('.activity-page').innerText(), /2 completed interviews/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkOverflow(page, 'history mobile');
  await screenshot(page, 'history-mobile');
  const download = page.waitForEvent('download');
  await page.locator('[data-summary="0"]').click();
  const summary = fs.readFileSync(await (await download).path(), 'utf8');
  assert.match(summary, /Clear reasoning\./);
  assert.match(summary, /candidate/i);
  report.checks.push('History totals candidate and interviewer sessions correctly and downloads candidate feedback');
  await page.context().close();
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await playwright.chromium.launch({ channel: process.env.MOCKSYRA_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const [name, run] of [['guest', verifyGuest], ['google-callback', verifyGoogleCallback], ['realtime-recovery', verifyRealtimeRecovery], ['auth-handshake-recovery', verifyAuthHandshakeRecovery], ['logout-failure', verifyLogoutFailure], ['auth-lifecycle', verifyAuthLifecycle], ['webrtc-rejection', verifyRejectedWebRtcAdmission], ...['candidate', 'interviewer'].map(mode => [mode, () => verifyMode(mode)]), ['hosted-video', verifyHostedVideo], ['history', verifyHistory]]) {
      try { await run(); process.stdout.write(`PASS ${name}\n`); }
      catch (error) { report.errors.push(`${name}: ${error.stack}`); process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
    }
    assert.equal(report.pageErrors.length, 0, `Browser errors: ${report.pageErrors.join('; ')}`);
  } catch (error) { report.errors.push(error.stack); }
  finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`UI report: ${path.join(artifactDir, 'report.json')}\n`);
    if (report.errors.length) { process.stderr.write(report.errors.join('\n') + '\n'); process.exitCode = 1; }
  }
})();
