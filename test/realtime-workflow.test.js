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
    next(name, predicate = () => true, timeoutMs = 5000) {
      const index = queued.findIndex(item => item.name === name && predicate(item.payload));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0].payload);
      return new Promise((resolve, reject) => {
        const item = { name, predicate, resolve: payload => { clearTimeout(timeout); resolve(payload); } };
        const timeout = setTimeout(() => { waiting.splice(waiting.indexOf(item), 1); reject(new Error(`No ${name} event`)); }, timeoutMs);
        waiting.push(item);
      });
    }
  };
}

test('authenticated directed workflow supports restore, collaboration, leaving, guarded finishing, mutual feedback and cancellation', { timeout: 30_000 }, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mocksyra-workflow-'));
  const clients = [];
  let child;
  const identities = {
    candidate: 'candidate@example.test', interviewer: 'interviewer@example.test', outsider: 'outsider@example.test', newcomer: 'newcomer@example.test',
    busyOwner: 'busy-owner@example.test', busyPeerOne: 'busy-peer-one@example.test', busyPeerTwo: 'busy-peer-two@example.test'
  };
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
  const busyOwner = { email: identities.busyOwner, name: 'Busy Owner', practiceMode: 'candidate', languages: ['JavaScript'], slots: [], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English', timezone: 'UTC', status: 'idle' };
  const busyPeerOne = { ...busyOwner, email: identities.busyPeerOne, name: 'Busy Peer One', practiceMode: 'interviewer' };
  const busyPeerTwo = { ...busyOwner, email: identities.busyPeerTwo, name: 'Busy Peer Two', practiceMode: 'interviewer' };
  const busyDataDirectory = path.join(fixtureDirectory, 'data');
  fs.mkdirSync(busyDataDirectory, { recursive: true });
  fs.writeFileSync(path.join(busyDataDirectory, 'mocksyra.json'), JSON.stringify({
    profiles: { [busyOwner.email]: busyOwner, [busyPeerOne.email]: busyPeerOne, [busyPeerTwo.email]: busyPeerTwo },
    listings: {},
    matches: {
      'busy-live-room': { id: 'busy-live-room', people: [busyOwner, busyPeerOne], sharedSlot: new Date(Date.now() + 5 * 60 * 1000).toISOString(), interviewType: 'Frontend', status: 'in_progress', sessionStartedAt: new Date().toISOString(), durationMinutes: 45, mediaProvider: 'webrtc', feedback: {} },
      'busy-upcoming-room': { id: 'busy-upcoming-room', people: [busyOwner, busyPeerTwo], sharedSlot: new Date(Date.now() + 5 * 60 * 1000).toISOString(), interviewType: 'Frontend', status: 'matched', durationMinutes: 45, mediaProvider: 'daily', feedback: {} }
    },
    notifications: []
  }));
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
  const newcomer = await connectSocket(baseUrl, 'newcomer'); clients.push(newcomer);
  const busyClient = await connectSocket(baseUrl, 'busyOwner'); clients.push(busyClient);
  const busyPreparation = await busyClient.ack('prepare-call', { roomId: 'busy-upcoming-room' });
  assert.equal(busyPreparation.ok, false, 'video credentials are not issued while either participant is in another live interview');
  assert.match(busyPreparation.error, /finish your current live interview/i);
  const preferences = { name: 'Ada', languages: ['JavaScript'], slots: [new Date(Date.now() + 5 * 60 * 1000).toISOString()], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English', timezone: 'UTC' };

  assert.equal((await candidate.ack('publish-listing', { ...preferences, practiceMode: 'peer' })).ok, false, 'removed peer role cannot publish');
  assert.equal((await candidate.ack('publish-listing', preferences)).ok, false, 'a role is required');
  const interviewerSlot = new Date(Date.now() + 6 * 60 * 1000).toISOString();
  const offered = await interviewer.ack('publish-listing', { ...preferences, name: 'Sam', slots: [interviewerSlot], languages: ['Python'], interviewType: 'System Design', practiceMode: 'interviewer' });
  assert.equal(offered.ok, true);
  assert.equal((await candidate.ack('publish-listing', { ...preferences, practiceMode: 'candidate' })).ok, true);
  let competingCandidate = await outsider.ack('publish-listing', { ...preferences, name: 'Pat', practiceMode: 'candidate' });
  assert.equal(competingCandidate.ok, true);
  const newcomerListings = await newcomer.ack('browse-listings', {});
  assert.equal(newcomerListings.listings.length, 3, 'a signed-in user can browse before creating a profile');
  assert.deepEqual(new Set(newcomerListings.listings.map(item => item.practiceMode)), new Set(['candidate', 'interviewer']), 'the board includes both offered roles');
  const directBooking = await newcomer.ack('book-listing', { listingId: competingCandidate.listing.listingId, slot: preferences.slots[0], profile: { name: 'New User', experience: 'Beginner', languages: ['JavaScript'], spokenLanguage: 'English', timezone: 'UTC' } });
  assert.equal(directBooking.ok, true, 'a new user can book directly from the sessions board');
  assert.equal(directBooking.activeMatch.role, 'interviewer', 'a candidate listing assigns the booker as interviewer');
  assert.equal(directBooking.profile.practiceMode, 'interviewer', 'the server, not the browser, derives the complementary role');
  assert.equal((await newcomer.ack('cancel-match', directBooking.activeMatch.roomId)).ok, true);
  competingCandidate = await outsider.ack('publish-listing', { ...preferences, name: 'Pat', practiceMode: 'candidate' });
  assert.equal(competingCandidate.ok, true);
  const available = await candidate.ack('browse-listings', {});
  assert.equal(available.listings.length, 2);
  const offeredListing = available.listings.find(item => item.listingId === offered.listing.listingId);
  assert.deepEqual(offeredListing.languages, ['Python'], 'other technologies remain visible in the marketplace');
  assert.equal(offeredListing.requiredRole, 'candidate', 'the server derives the role needed for each listing');
  assert.equal(Object.hasOwn(offeredListing, 'email'), false, 'public listings never expose email');
  assert.equal(Object.hasOwn(offeredListing, 'roomId'), false, 'public listings never expose a room');
  assert.notEqual(offeredListing.slots[0], preferences.slots[0], 'other time slots remain visible');
  assert.equal((await interviewer.ack('browse-listings', {})).listings.every(item => item.practiceMode === 'candidate'), true);
  const found = await candidate.ack('book-listing', { listingId: offered.listing.listingId, slot: offeredListing.slots[0] });
  const match = found.activeMatch, roomId = match.roomId;
  assert.equal(found.ok, true);
  assert.equal(match.source, 'marketplace');
  assert.equal(match.sessionMode, 'directed');
  assert.equal(match.phase, 1);
  assert.equal(match.score, null);
  assert.equal((await outsider.ack('book-listing', { listingId: offered.listing.listingId, slot: offeredListing.slots[0] })).ok, false, 'a listed session cannot be double booked');
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
  assert.equal((await interviewer.next('peer-entered-room')).roomId, roomId);
  assert.equal((await candidate.ack('complete-session', roomId)).ok, false, 'a lone participant cannot finish an unstarted interview');
  assert.equal((await interviewer.ack('join-session', roomId)).ok, true);
  assert.equal((await candidate.next('peer-entered-room')).roomId, roomId);
  const ready = await candidate.next('session-ready');
  assert.equal(ready.durationMinutes, 45);
  assert.equal(ready.role, 'candidate');
  assert.ok(ready.startedAt);
  assert.equal((await interviewer.ack('cancel-match', roomId)).ok, false);

  candidate.emit('signal', { roomId, data: { roomId: 'spoofed-room', type: 'offer', sdp: 'test-offer' } });
  const relayedSignal = await interviewer.next('signal');
  assert.equal(relayedSignal.roomId, roomId, 'nested signal data cannot override the validated room ID');
  assert.equal(relayedSignal.type, 'offer');
  assert.equal(relayedSignal.sdp, 'test-offer');

  candidate.emit('workspace-update', { roomId, code: 'console.log(42)', language: 'JavaScript' });
  const workspaceUpdate = await interviewer.next('workspace-update');
  assert.equal(workspaceUpdate.roomId, roomId);
  assert.equal(workspaceUpdate.code, 'console.log(42)');
  interviewer.emit('chat-message', { roomId, message: 'Talk through your approach.' });
  const chatMessage = await candidate.next('chat-message');
  assert.equal(chatMessage.roomId, roomId);
  assert.equal(chatMessage.message, 'Talk through your approach.');
  const feedback = { scores: [5, 4, 3], strength: 'Helpful examples.', improve: 'Allow more thinking time.', practiseAgain: true };
  assert.equal((await candidate.ack('submit-feedback', { roomId, feedback })).ok, false, 'feedback cannot be submitted before ending the interview');
  assert.equal((await candidate.ack('leave-session', roomId)).ok, true);
  assert.equal((await interviewer.next('peer-left')).roomId, roomId);
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
  const readyFeedback = await interviewer.next('feedback-ready');
  assert.equal(readyFeedback.roomId, roomId);
  assert.deepEqual(readyFeedback.criteria, ['Question clarity', 'Guidance', 'Professionalism']);
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

  const offerSlots = [2, 4, 6, 8].map(hours => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString());
  const multipleOffers = await newcomer.ack('publish-listing', { ...preferences, name: 'New User', practiceMode: 'candidate', slots: offerSlots });
  assert.equal(multipleOffers.ok, true);
  assert.equal(multipleOffers.listingsCreated.length, 4, 'one account can publish four independent times');
  assert.equal(multipleOffers.ownListings.length, 4, 'all of the account’s open offers are returned');
  assert.equal(multipleOffers.ownListings.some(item => Object.hasOwn(item, 'email')), false, 'owned schedule payloads do not leak account email into UI data');
  const fifthOffer = await newcomer.ack('publish-listing', { ...preferences, name: 'New User', practiceMode: 'candidate', slots: [new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString()] });
  assert.equal(fifthOffer.ok, false, 'the fifth open offer is rejected until one is cancelled');
  const removedListingId = multipleOffers.ownListings[1].listingId;
  assert.equal((await outsider.ack('cancel-listing', { listingId: removedListingId })).ok, false, 'another account cannot cancel an offer');
  const oneOfferCancelled = await newcomer.ack('cancel-listing', { listingId: removedListingId });
  assert.equal(oneOfferCancelled.ok, true);
  assert.equal(oneOfferCancelled.ownListings.length, 3, 'one offer is cancelled without removing the others');
  assert.equal(oneOfferCancelled.ownListings.some(item => item.listingId === removedListingId), false);
  assert.equal((await newcomer.ack('cancel-search')).ownListings.length, 0, 'cancel-search remains a compatible way to remove all open offers');

  const bookingSlots = [2, 4, 6, 8].map(hours => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString());
  const bookable = await outsider.ack('publish-listing', { ...preferences, name: 'Pat', practiceMode: 'interviewer', slots: bookingSlots });
  assert.equal(bookable.ok, true);
  const firstFutureBooking = await newcomer.ack('book-listing', { listingId: bookable.listingsCreated[0].listingId, slot: bookingSlots[0] });
  assert.equal(firstFutureBooking.ok, true);
  assert.equal(firstFutureBooking.activeMatches.length, 1);
  const overlapSlot = new Date(Date.parse(bookingSlots[0]) + 45 * 60 * 1000).toISOString();
  const overlapOffer = await candidate.ack('publish-listing', { ...preferences, name: 'Ada', practiceMode: 'interviewer', slots: [overlapSlot] });
  assert.equal(overlapOffer.ok, true);
  const overlappingBooking = await newcomer.ack('book-listing', { listingId: overlapOffer.listing.listingId, slot: overlapSlot });
  assert.equal(overlappingBooking.ok, false, 'a back-to-back booking is rejected because the first room may start during its grace window');
  assert.match(overlappingBooking.error, /overlap/i);
  assert.equal((await candidate.ack('cancel-search')).ok, true);
  const secondFutureBooking = await newcomer.ack('book-listing', { listingId: bookable.listingsCreated[1].listingId, slot: bookingSlots[1] });
  assert.equal(secondFutureBooking.ok, true);
  assert.equal(secondFutureBooking.activeMatches.length, 2, 'multiple non-overlapping confirmed interviews are returned together');
  assert.deepEqual(new Set(secondFutureBooking.activeMatches.map(item => item.roomId)).size, 2);
  assert.equal(secondFutureBooking.activeMatches.some(item => Object.hasOwn(item.peer, 'email')), false, 'confirmed cards expose no private peer email');
  const thirdFutureBooking = await newcomer.ack('book-listing', { listingId: bookable.listingsCreated[2].listingId, slot: bookingSlots[2] });
  assert.equal(thirdFutureBooking.activeMatches.length, 3);
  const fourthFutureBooking = await newcomer.ack('book-listing', { listingId: bookable.listingsCreated[3].listingId, slot: bookingSlots[3] });
  assert.equal(fourthFutureBooking.activeMatches.length, 4, 'all four allowed bookings are kept in the schedule');
  outsider.emit('restore-profile');
  const providerSchedule = await outsider.next('profile-state');
  assert.equal(providerSchedule.activeMatches.length, 4, 'the person offering times sees the same four confirmed interviews');
  assert.equal(providerSchedule.activeMatches.every(item => item.practiceMode === 'interviewer'), true);
  const overflowSlot = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
  const overflowOffer = await candidate.ack('publish-listing', { ...preferences, name: 'Ada', practiceMode: 'interviewer', slots: [overflowSlot] });
  assert.equal(overflowOffer.ok, true);
  assert.equal((await newcomer.ack('book-listing', { listingId: overflowOffer.listing.listingId, slot: overflowSlot })).ok, false, 'a fifth upcoming booking is rejected');
  assert.equal((await candidate.ack('cancel-search')).ok, true);
  const secondRoomId = fourthFutureBooking.activeMatches.find(item => item.listingId === bookable.listingsCreated[1].listingId).roomId;
  const roomsBeforeCancellation = new Set(fourthFutureBooking.activeMatches.map(item => item.roomId));
  const oneBookingCancelled = await newcomer.ack('cancel-match', secondRoomId);
  assert.equal(oneBookingCancelled.ok, true);
  assert.equal(oneBookingCancelled.activeMatches.length, 3, 'cancelling one interview preserves the other confirmed bookings');
  assert.equal(oneBookingCancelled.activeMatches.some(item => item.roomId === secondRoomId), false, 'the requested interview is the one removed');
  assert.deepEqual(new Set(oneBookingCancelled.activeMatches.map(item => item.roomId)), new Set([...roomsBeforeCancellation].filter(roomId => roomId !== secondRoomId)));
  newcomer.emit('restore-profile');
  const restoredMultipleSchedule = await newcomer.next('profile-state');
  assert.equal(restoredMultipleSchedule.activeMatches.length, 3);
  assert.equal(restoredMultipleSchedule.ownListings.length, 0);
  for (const remaining of restoredMultipleSchedule.activeMatches) assert.equal((await newcomer.ack('cancel-match', remaining.roomId)).ok, true);
  assert.equal((await outsider.ack('cancel-search')).ok, true);
  const stalePeerLeft = interviewer.next('peer-left', packet => packet?.roomId === roomId, 250);
  candidate.close();
  await assert.rejects(stalePeerLeft, /No peer-left event/, 'completed interviews are evicted from their Socket.IO room before a later disconnect');
});
