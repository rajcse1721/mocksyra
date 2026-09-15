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
  const acknowledgements = new Map();
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
      }
    });
  });
  try { await ready; } catch (error) { ws.close(); throw error; }
  return {
    close: () => ws.close(),
    ack(name, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { acknowledgements.delete(id); reject(new Error(`No acknowledgement for ${name}`)); }, 8000);
        acknowledgements.set(id, result => { clearTimeout(timeout); acknowledgements.delete(id); resolve(result); });
        ws.send(`42${id}${JSON.stringify(payload === undefined ? [name] : [name, payload])}`);
      });
    }
  };
}

test('Daily credentials are returned only when admission is still valid after the external API awaits', { timeout: 25_000 }, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mocksyra-daily-admission-'));
  const clients = [];
  let child;
  let blockTokens = false;
  let tokenObservedResolve;
  let pendingTokenResponses = [];
  let tokenSequence = 0;

  const identities = { candidate: 'daily-candidate@example.test', interviewer: 'daily-interviewer@example.test' };
  const auth = http.createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (request.url !== '/auth/v1/user' || !identities[token]) { response.writeHead(401); response.end('{}'); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: token, email: identities[token] }));
  });
  const daily = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const packet = JSON.parse(body || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/rooms') {
      response.end(JSON.stringify({ name: packet.name, url: `https://fixture.daily.test/${packet.name}` }));
      return;
    }
    if (request.url === '/v1/meeting-tokens') {
      const send = () => response.end(JSON.stringify({ token: `daily-fixture-token-${++tokenSequence}` }));
      if (blockTokens) {
        pendingTokenResponses.push(send);
        tokenObservedResolve?.();
      } else send();
      return;
    }
    response.writeHead(404); response.end('{}');
  });

  t.after(async () => {
    pendingTokenResponses.splice(0).forEach(send => send());
    clients.forEach(client => client.close());
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    auth.closeAllConnections(); daily.closeAllConnections();
    await Promise.all([new Promise(resolve => auth.close(resolve)), new Promise(resolve => daily.close(resolve))]);
    assert.ok(fixtureDirectory.startsWith(path.join(os.tmpdir(), 'mocksyra-daily-admission-')));
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  auth.listen(0, '127.0.0.1'); daily.listen(0, '127.0.0.1');
  await Promise.all([once(auth, 'listening'), once(daily, 'listening')]);
  for (const file of ['server.js', 'session-rules.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixtureDirectory, file));
  const dailyPrefix = 'https://api.daily.co/v1/';
  const bootstrap = `const nativeFetch=global.fetch;global.fetch=(url,options)=>{const value=String(url);return nativeFetch(value.startsWith(${JSON.stringify(dailyPrefix)})?process.env.MOCKSYRA_DAILY_STUB+value.slice(${dailyPrefix.length}):url,options)};const {server}=require(process.env.MOCKSYRA_FIXTURE_SERVER);server.listen(0,'127.0.0.1',()=>console.log('FIXTURE_PORT='+server.address().port));`;
  child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: fixtureDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      MOCKSYRA_FIXTURE_SERVER: path.join(fixtureDirectory, 'server.js'),
      MOCKSYRA_DAILY_STUB: `http://127.0.0.1:${daily.address().port}/v1/`,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      SUPABASE_URL: `http://127.0.0.1:${auth.address().port}`,
      SUPABASE_PUBLISHABLE_KEY: 'test-publishable',
      SUPABASE_SECRET_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
      DAILY_API_KEY: 'daily-test-key', RESEND_API_KEY: '', EMAIL_FROM: ''
    },
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
  const candidate = await connectSocket(baseUrl, 'candidate'); clients.push(candidate);
  const interviewer = await connectSocket(baseUrl, 'interviewer'); clients.push(interviewer);
  const slot = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const offer = await candidate.ack('publish-listing', {
    name: 'Daily Candidate', practiceMode: 'candidate', languages: ['JavaScript'], slots: [slot], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English', timezone: 'UTC'
  });
  assert.equal(offer.ok, true);
  const booked = await interviewer.ack('book-listing', { listingId: offer.listing.listingId, slot, profile: { name: 'Daily Interviewer' } });
  assert.equal(booked.ok, true);
  const roomId = booked.activeMatch.roomId;

  const normalAccess = await candidate.ack('prepare-call', { roomId });
  assert.equal(normalAccess.ok, true);
  assert.equal(normalAccess.provider, 'daily');
  assert.match(normalAccess.token, /^daily-fixture-token-/);

  blockTokens = true;
  const tokenObserved = new Promise(resolve => { tokenObservedResolve = resolve; });
  const delayedAccess = candidate.ack('prepare-call', { roomId });
  await tokenObserved;
  const cancelled = await interviewer.ack('cancel-match', roomId);
  assert.equal(cancelled.ok, true);
  blockTokens = false;
  pendingTokenResponses.splice(0).forEach(send => send());
  const staleAccess = await delayedAccess;
  assert.equal(staleAccess.ok, false);
  assert.match(staleAccess.error, /no longer available/i);
  assert.equal(Object.hasOwn(staleAccess, 'token'), false, 'a token minted during a cancellation race is never delivered to the browser');
});
