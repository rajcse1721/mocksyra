const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function connectSocket(baseUrl, token) {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/socket.io/?EIO=4&transport=websocket`);
  const queued = [], waiting = [], acknowledgements = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket authentication timed out')), 8000);
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Test socket transport failed')); });
    ws.addEventListener('message', event => {
      const frame = String(event.data);
      if (frame.startsWith('0')) ws.send(`40${JSON.stringify({ accessToken: token })}`);
      else if (frame === '2') ws.send('3');
      else if (frame.startsWith('40')) { clearTimeout(timeout); resolve(); }
      else if (frame.startsWith('44')) { clearTimeout(timeout); reject(new Error(JSON.parse(frame.slice(2)).message)); }
      else if (frame.startsWith('43')) {
        const split = frame.indexOf('['), id = Number(frame.slice(2, split));
        acknowledgements.get(id)?.(JSON.parse(frame.slice(split))[0]);
      } else if (frame.startsWith('42')) {
        const [name, payload] = JSON.parse(frame.slice(frame.indexOf('[')));
        const index = waiting.findIndex(item => item.name === name && item.predicate(payload));
        if (index >= 0) waiting.splice(index, 1)[0].resolve(payload);
        else queued.push({ name, payload });
      }
    });
  });
  try { await ready; } catch (error) { ws.close(); throw error; }
  return {
    close: () => ws.close(),
    emit: (name, payload) => ws.send(`42${JSON.stringify(payload === undefined ? [name] : [name, payload])}`),
    ack(name, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { acknowledgements.delete(id); reject(new Error(`No acknowledgement for ${name}`)); }, 5000);
        acknowledgements.set(id, result => { clearTimeout(timeout); acknowledgements.delete(id); resolve(result); });
        ws.send(`42${id}${JSON.stringify(payload === undefined ? [name] : [name, payload])}`);
      });
    },
    next(name, predicate = () => true) {
      const index = queued.findIndex(item => item.name === name && predicate(item.payload));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0].payload);
      return new Promise((resolve, reject) => {
        const item = { name, predicate, resolve: payload => { clearTimeout(timeout); resolve(payload); } };
        const timeout = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error(`No ${name} event`)); }, 5000);
        waiting.push(item);
      });
    }
  };
}

test('authenticated directed workflow supports restore, collaboration, leaving, guarded finishing, mutual feedback and cancellation', { timeout: 30_000 }, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mocksyra-workflow-'));
  const clients = [];
  let child;
  const identities = { candidate: 'candidate@example.test', interviewer: 'interviewer@example.test', outsider: 'outsider@example.test' };
  const auth = http.createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (request.url !== '/auth/v1/user' || !identities[token]) { response.writeHead(401); response.end('{}'); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: token, email: identities[token] }));
  });
  t.after(async () => {
    clients.forEach(client => client.close());
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    auth.closeAllConnections();
    await new Promise(resolve => auth.close(resolve));
    // This directory is created by this test, contains no user data, and is never a workspace root.
    assert.ok(fixtureDirectory.startsWith(path.join(os.tmpdir(), 'mocksyra-workflow-')));
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });
  auth.listen(0, '127.0.0.1');
  await once(auth, 'listening');
  for (const file of ['server.js', 'session-rules.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixtureDirectory, file));
  child = spawn(process.execPath, ['-e', "const {server}=require(process.env.MOCKSYRA_FIXTURE_SERVER);server.listen(0,'127.0.0.1',()=>console.log('FIXTURE_PORT='+server.address().port));"], {
    cwd: fixtureDirectory,
    windowsHide: true,
    env: { ...process.env, MOCKSYRA_FIXTURE_SERVER: path.join(fixtureDirectory, 'server.js'), NODE_PATH: path.join(__dirname, '..', 'node_modules'), SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`, SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_PUBLISHABLE_KEY: 'test-publishable', RESEND_API_KEY: '', EMAIL_FROM: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const port = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error(`Fixture did not start: ${errors}`)), 8000);
    child.stderr.on('data', part => { errors += part; });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${errors}`)); });
    child.stdout.on('data', part => {
      output += part;
      const found = /FIXTURE_PORT=(\d+)/.exec(output);
      if (found) { clearTimeout(timeout); resolve(Number(found[1])); }
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(connectSocket(baseUrl, 'invalid-token'), /Authentication required/);
  const candidate = await connectSocket(baseUrl, 'candidate'); clients.push(candidate);
  const interviewer = await connectSocket(baseUrl, 'interviewer'); clients.push(interviewer);
  const outsider = await connectSocket(baseUrl, 'outsider'); clients.push(outsider);
  const preferences = { name: 'Ada', languages: ['JavaScript'], slots: [new Date(Date.now() + 5 * 60 * 1000).toISOString()], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English', timezone: 'UTC' };

  const interviewerSlot = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  const offered = await interviewer.ack('publish-listing', { ...preferences, name: 'Sam', slots: [interviewerSlot], languages: ['Python'], interviewType: 'System Design', practiceMode: 'interviewer' });
  assert.equal(offered.ok, true);
  assert.equal((await candidate.ack('publish-listing', { ...preferences, practiceMode: 'candidate' })).ok, true);
  assert.equal((await outsider.ack('publish-listing', { ...preferences, name: 'Pat', practiceMode: 'candidate' })).ok, true);
  const available = await candidate.ack('browse-listings', {});
  assert.equal(available.listings.length, 1);
  assert.equal(available.listings[0].listingId, offered.profile.listingId);
  assert.deepEqual(available.listings[0].languages, ['Python'], 'other technologies remain visible in the marketplace');
  assert.equal(Object.hasOwn(available.listings[0], 'email'), false, 'public listings never expose email');
  assert.equal(Object.hasOwn(available.listings[0], 'roomId'), false, 'public listings never expose a room');
  assert.notEqual(available.listings[0].slots[0], preferences.slots[0], 'other time slots remain visible');
  assert.equal((await interviewer.ack('browse-listings', {})).listings.every(item => item.practiceMode === 'candidate'), true);
  const found = await candidate.ack('book-listing', { listingId: offered.profile.listingId, slot: available.listings[0].slots[0] });
  const match = found.activeMatch, roomId = match.roomId;
  assert.equal(found.ok, true);
  assert.equal(match.source, 'marketplace');
  assert.equal(match.score, null);
  assert.equal((await outsider.ack('book-listing', { listingId: offered.profile.listingId, slot: available.listings[0].slots[0] })).ok, false, 'a listed session cannot be double booked');
  assert.equal((await outsider.ack('cancel-search')).ok, true, 'the unsuccessful competing listing is cleaned up before later matching checks');
  assert.equal(match.initiator, true);
  assert.equal(match.role, 'candidate');
  assert.equal(match.question.hints, undefined);
  const partnerMatch = await interviewer.next('match-found');
  assert.equal(partnerMatch.roomId, roomId);
  assert.ok(partnerMatch.question.hints.length);
  assert.equal((await candidate.ack('prepare-call', { roomId })).provider, 'webrtc');
  assert.equal((await outsider.ack('prepare-call', { roomId })).ok, false);
  candidate.emit('restore-profile');
  const restored = await candidate.next('profile-state');
  assert.equal(restored.profile.practiceMode, 'candidate');
  assert.equal(restored.activeMatch.roomId, roomId);
  assert.equal((await outsider.ack('join-session', roomId)).ok, false);
  assert.equal((await candidate.ack('join-session', roomId)).ok, true);
  assert.equal((await candidate.ack('complete-session', roomId)).ok, false, 'a lone participant cannot finish an unstarted interview');
  assert.equal((await interviewer.ack('join-session', roomId)).ok, true);
  const ready = await candidate.next('session-ready');
  assert.equal(ready.durationMinutes, 45);
  assert.equal(ready.role, 'candidate');
  assert.ok(ready.startedAt);
  assert.equal((await interviewer.ack('cancel-match', roomId)).ok, false);

  candidate.emit('workspace-update', { roomId, code: 'console.log(42)', language: 'JavaScript' });
  assert.equal((await interviewer.next('workspace-update')).code, 'console.log(42)');
  interviewer.emit('chat-message', { roomId, message: 'Talk through your approach.' });
  assert.equal((await candidate.next('chat-message')).message, 'Talk through your approach.');
  const feedback = { scores: [5, 4, 3], strength: 'Helpful examples.', improve: 'Allow more thinking time.', practiseAgain: true };
  assert.equal((await candidate.ack('submit-feedback', { roomId, feedback })).ok, false, 'feedback cannot be submitted before ending the interview');
  assert.equal((await candidate.ack('leave-session', roomId)).ok, true);
  await interviewer.next('peer-left');
  assert.equal((await candidate.ack('complete-session', roomId)).ok, false, 'a participant that left the room cannot end it remotely');
  candidate.emit('workspace-update', { roomId, code: 'blocked update', language: 'JavaScript' });
  interviewer.emit('workspace-request', roomId);
  assert.equal((await interviewer.next('workspace-state')).code, 'console.log(42)');
  assert.equal((await candidate.ack('join-session', roomId)).startedAt, ready.startedAt);
  assert.equal((await candidate.ack('complete-session', roomId)).ok, true);
  await interviewer.next('session-ended');
  assert.equal((await candidate.ack('join-session', roomId)).ok, false, 'feedback rooms cannot reopen');
  assert.equal((await candidate.ack('submit-feedback', { roomId, feedback: { ...feedback, scores: [0, 4, 3] } })).ok, false);
  const submitted = await candidate.ack('submit-feedback', { roomId, feedback });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.completed, false);
  assert.deepEqual(submitted.selfFeedback.criteria, ['Question clarity', 'Guidance', 'Professionalism']);
  candidate.emit('restore-profile');
  const waitingFeedback = await candidate.next('profile-state');
  assert.equal(waitingFeedback.activeMatch.feedbackSubmitted, true);
  assert.deepEqual(waitingFeedback.activeMatch.selfFeedback.scores, [5, 4, 3]);
  assert.equal((await interviewer.ack('submit-feedback', { roomId, feedback })).completed, true);
  assert.deepEqual((await interviewer.next('feedback-ready')).criteria, ['Question clarity', 'Guidance', 'Professionalism']);
  assert.equal((await candidate.ack('submit-feedback', { roomId, feedback })).completed, true, 'retry acknowledgement is idempotent');
  candidate.emit('restore-profile');
  const completed = await candidate.next('profile-state');
  assert.equal(completed.activeMatch, null);
  assert.equal(completed.profile.stats.sessionsCompleted, 1);
  assert.equal(completed.history.length, 1);
  assert.deepEqual(completed.history[0].feedbackReceived.criteria, ['Problem solving', 'Communication', 'Technical depth']);

  await interviewer.ack('find-match', { ...preferences, name: 'Sam', practiceMode: 'interviewer' });
  const rematch = await candidate.ack('find-match', { ...preferences, practiceMode: 'candidate' });
  assert.equal((await outsider.ack('cancel-match', rematch.activeMatch.roomId)).ok, false);
  assert.equal((await candidate.ack('cancel-match', rematch.activeMatch.roomId)).ok, true);
  await interviewer.next('match-cancelled');
  assert.equal((await interviewer.ack('join-session', rematch.activeMatch.roomId)).ok, false);
});
