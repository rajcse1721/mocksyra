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
      const user = { id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.test', user_metadata: { full_name: 'Alex Morgan' } };
      const session = () => localStorage.getItem('mocksyra-email') ? { user, access_token: 'local-fixture-token' } : null;
      return {
        auth: {
          getSession: async () => ({ data: { session: session() }, error: null }),
          getUser: async () => ({ data: { user: session() ? user : null }, error: null }),
          signInWithPassword: async ({ email }) => ({ data: { session: { user: { ...user, email }, access_token: 'local-fixture-token' } }, error: null }),
          signInWithOAuth: async options => { window.__oauthOptions = options; return { data: { provider: 'google' }, error: null }; },
          signUp: async () => ({ data: { session: null }, error: null }),
          signOut: async () => ({ error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
        },
        from: () => ({ upsert: async payload => { window.__savedProfile = payload; return { data: null, error: null }; } })
      };
    }
  };
}

function fakeSocketSDK() {
  window.io = () => {
    const listeners = new Map();
    const socket = {
      connected: false,
      auth: {},
      sent: [],
      on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return socket; },
      once(event, fn) { const once = (...args) => { socket.off(event, once); return fn(...args); }; return socket.on(event, once); },
      off(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); return socket; },
      connect() { socket.connected = true; queueMicrotask(() => socket.receive('connect')); return socket; },
      disconnect() { socket.connected = false; return socket; },
      receive(event, payload) { return Promise.all((listeners.get(event) || []).slice().map(fn => fn(payload))); },
      emit(event, payload, ack) {
        socket.sent.push({ event, payload });
        if (event === 'publish-listing') {
          socket.profile = { ...payload, status: 'waiting', listingId: 'self-listing' };
          if (typeof ack === 'function') ack({ ok: true, profile: socket.profile, listings: [], serverNow: new Date().toISOString() });
          return socket;
        }
        if (event === 'browse-listings') {
          const slot = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          const listings = [
            { listingId: 'fixture-interviewer-listing', name: 'Maya Sharma', experience: 'Intermediate', languages: ['Python', 'AWS'], sessionsCompleted: 4, practiceMode: 'interviewer', requiredRole: 'candidate', interviewType: 'System Design', spokenLanguage: 'English', timezone: 'Asia/Kolkata', slots: [slot] },
            { listingId: 'fixture-candidate-listing', name: 'Ravi Mehta', experience: 'Beginner', languages: ['JavaScript', 'React'], sessionsCompleted: 2, practiceMode: 'candidate', requiredRole: 'interviewer', interviewType: 'Frontend', spokenLanguage: 'English + Hindi', timezone: 'Asia/Kolkata', slots: [new Date(Date.now() + 10 * 60 * 1000).toISOString()] }
          ];
          if (typeof ack === 'function') ack({ ok: true, listings, serverNow: new Date().toISOString() });
          return socket;
        }
        if (event === 'book-listing') {
          const practiceMode = payload.profile?.practiceMode || 'candidate';
          socket.profile = { ...payload.profile, status: 'matched' };
          const now = Date.now(), activeMatch = { roomId: `fixture-${practiceMode}-123456`, peer: { name: 'Maya Sharma', experience: 'Intermediate', languages: ['Python', 'AWS'], sessionsCompleted: 4 }, practiceMode, sessionMode: 'directed', peerRole: practiceMode === 'candidate' ? 'interviewer' : 'candidate', durationMinutes: 45, startsAsInterviewer: practiceMode === 'interviewer', initiator: false, score: null, source: 'marketplace', bookingType: 'marketplace', reasons: ['Session selected by you'], sharedSlot: new Date(now + 5 * 60 * 1000).toISOString(), opensAt: new Date(now - 5 * 60 * 1000).toISOString(), closesAt: new Date(now + 20 * 60 * 1000).toISOString(), serverNow: new Date(now).toISOString(), canJoinNow: true, videoProvider: window.__fixtureHostedVideo ? 'daily' : 'webrtc', interviewType: 'System Design', question: { title: 'Build a service', prompt: 'Explain and implement a reliable service.', ...(practiceMode === 'interviewer' ? { hints: ['Fixture interviewer-only hint'] } : {}) }, feedbackCriteria: practiceMode === 'candidate' ? ['Question clarity', 'Guidance', 'Professionalism'] : ['Problem solving', 'Communication', 'Technical depth'], feedbackSubmitted: false, selfFeedback: null, status: 'matched' };
          if (typeof ack === 'function') ack({ ok: true, activeMatch });
          return socket;
        }
        if (event === 'prepare-call') { if (typeof ack === 'function') ack(window.__fixtureHostedVideo ? { ok: true, provider: 'daily', roomUrl: 'https://fixture.daily.test/private-room', token: 'short-lived-fixture-token' } : { ok: true, provider: 'webrtc' }); return socket; }
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
      async leave() { listeners.get('left-meeting')?.(); },
      destroy() { surface.remove(); }
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

async function newPage(authenticated = true, hostedVideo = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Kolkata', locale: 'en-IN', reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/@supabase/')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeSupabaseSDK})();` });
    if (url.includes('cdn.socket.io/') || url.endsWith('/socket.io/socket.io.js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeSocketSDK})();` });
    if (url.includes('@daily-co/daily-js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fakeDailySDK})();` });
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    report.blockedRemoteRequests.push(url);
    return route.abort();
  });
  await context.addInitScript(isolateDevices);
  await context.addInitScript(value => { window.__fixtureHostedVideo = value; }, hostedVideo);
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
  await page.locator('.session-card').first().waitFor();
  assert.equal(await page.locator('.session-card').count(), 2, 'a new account sees every open role without onboarding first');
  await page.evaluate(match => window.__mocksyraSocket.receive('match-found', match), fixtureMatch('candidate'));
  await page.locator('.upcoming-card').waitFor();
  assert.match(await page.locator('.upcoming-card').innerText(), /Your next interview|Join now|View booking/i);
  assert.equal(await page.locator('.session-card').count(), 2, 'open listings remain visible below an upcoming interview');
  assert.equal(await page.locator('[data-book-listing]:disabled').count(), 2, 'a user cannot double-book while an interview is active');
  await screenshot(page, 'sessions-upcoming-mobile');
  report.checks.push('Simple auth, clean Google callback, all open listings and private upcoming interview card');
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
  await page.waitForURL('**/#marketplace');
  await page.locator('.session-card').first().waitFor();
  assert.match(await page.locator('#marketplace-results').innerText(), /Python|AWS/);
  assert.match(await page.locator('#marketplace-results').innerText(), /Interviewer available/i);
  assert.match(await page.locator('#marketplace-results').innerText(), /Candidate looking/i);
  assert.equal(await page.locator('.session-card').getByText(/Join room/i).count(), 0, 'public listing never exposes Join');
  if (practiceMode === 'candidate') {
    await screenshot(page, 'marketplace-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await checkOverflow(page, 'marketplace mobile'); await screenshot(page, 'marketplace-mobile');
    await page.setViewportSize({ width: 320, height: 720 }); await checkOverflow(page, 'marketplace small mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.locator(`[data-book-role="${practiceMode}"]`).first().click();
  const match = fixtureMatch(practiceMode); match.durationMinutes = 45;
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
  await page.locator('#test-devices').click();
  await page.waitForFunction(() => document.querySelector('#device-preview')?.srcObject?.active);
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
  await page.locator('#complete').click();
  await page.locator('#submit').waitFor();
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
  await page.locator('#join').click();
  await page.waitForFunction(() => Boolean(window.__dailyJoin));
  assert.equal(await page.evaluate(() => window.__dailyJoin.url), 'https://fixture.daily.test/private-room');
  assert.equal(await page.evaluate(() => [...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index))).some(value => value?.includes('short-lived-fixture-token'))), false, 'Daily token is never persisted');
  assert.equal(await page.locator('#local').count(), 0, 'Daily owns camera and microphone capture');
  assert.match(await page.locator('#daily-status').innerText(), /connected/i);
  await page.setViewportSize({ width: 390, height: 844 });
  await checkOverflow(page, 'hosted video mobile'); await screenshot(page, 'session-daily-mobile');
  report.checks.push('Daily Prebuilt path requests short-lived credentials, avoids token persistence and fits mobile');
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
    for (const [name, run] of [['guest', verifyGuest], ...['candidate', 'interviewer'].map(mode => [mode, () => verifyMode(mode)]), ['hosted-video', verifyHostedVideo], ['history', verifyHistory]]) {
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
