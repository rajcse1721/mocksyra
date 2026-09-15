const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function isoHoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function waitForStarted(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);
    const timeout = setTimeout(() => fail(new Error(`Migration fixture did not start: ${stderr}`)), 8000);

    child.stderr.on('data', part => { stderr += part; });
    child.stdout.on('data', part => {
      stdout += part;
      if (stdout.includes('Mocksyra is running at')) succeed();
    });
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Migration fixture exited ${code}: ${stderr}`)));
  });
}

test('real startup migrates legacy waiting state without losing completed history', { timeout: 15_000 }, async t => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mocksyra-legacy-migration-'));
  const fixtureDataDirectory = path.join(fixtureDirectory, 'data');
  let child;

  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    assert.ok(fixtureDirectory.startsWith(path.join(os.tmpdir(), 'mocksyra-legacy-migration-')));
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  fs.mkdirSync(fixtureDataDirectory, { recursive: true });
  for (const file of ['server.js', 'session-rules.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixtureDirectory, file));
  }

  const futureSlots = [24, 48, 72, 96, 120].map(isoHoursFromNow);
  const completedMatch = {
    id: 'completed-peer-history',
    status: 'completed',
    sharedSlot: isoHoursFromNow(-48),
    completedAt: isoHoursFromNow(-47),
    interviewType: 'Frontend',
    people: [
      { email: 'legacy@example.test', name: 'Legacy User', practiceMode: 'peer' },
      { email: 'past-peer@example.test', name: 'Past Peer', practiceMode: 'peer' }
    ],
    feedback: { preserved: true }
  };
  const legacyState = {
    profiles: {
      'legacy@example.test': {
        email: 'legacy@example.test',
        name: 'Legacy User',
        languages: ['JavaScript'],
        slots: futureSlots,
        interviewType: 'Frontend',
        experience: 'Intermediate',
        spokenLanguage: 'English',
        practiceMode: 'peer',
        timezone: 'UTC',
        status: 'waiting',
        listingId: 'legacy-listing-id',
        stats: { sessionsCompleted: 7, ratingTotal: 30, averageRating: 30 / 7 },
        updatedAt: isoHoursFromNow(-2)
      }
    },
    matches: {
      [completedMatch.id]: completedMatch,
      'active-peer-room': {
        id: 'active-peer-room',
        status: 'matched',
        sharedSlot: futureSlots[0],
        people: [
          { email: 'legacy@example.test', name: 'Legacy User', practiceMode: 'peer' },
          { email: 'other@example.test', name: 'Other User', practiceMode: 'candidate' }
        ]
      }
    },
    notifications: [{ id: 'preserved-notification', email: 'legacy@example.test' }]
  };
  fs.writeFileSync(path.join(fixtureDataDirectory, 'mocksyra.json'), JSON.stringify(legacyState, null, 2));

  child = spawn(process.execPath, ['server.js'], {
    cwd: fixtureDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: '0',
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      DAILY_API_KEY: '',
      RESEND_API_KEY: '',
      EMAIL_FROM: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForStarted(child);

  const migrated = JSON.parse(fs.readFileSync(path.join(fixtureDataDirectory, 'mocksyra.json'), 'utf8'));
  const profile = migrated.profiles['legacy@example.test'];
  const listings = Object.values(migrated.listings);

  assert.equal(child.exitCode, null, 'the real server remains healthy after migration');
  assert.equal(profile.status, 'idle', 'legacy queue status is reset on the account profile');
  assert.equal(profile.practiceMode, 'candidate', 'removed peer mode receives the safe candidate default');
  assert.equal(Object.hasOwn(profile, 'listingId'), false, 'the obsolete profile-level listing id is removed');
  assert.deepEqual(profile.stats, legacyState.profiles['legacy@example.test'].stats, 'account statistics are preserved');

  assert.equal(listings.length, 4, 'at most four future legacy times become independent offers');
  assert.ok(migrated.listings['legacy-listing-id'], 'the first legacy listing id remains usable for cached clients');
  assert.deepEqual(listings.map(listing => listing.slots[0]), futureSlots.slice(0, 4));
  assert.ok(listings.every(listing => listing.status === 'waiting' && listing.slots.length === 1));
  assert.ok(listings.every(listing => listing.email === 'legacy@example.test' && listing.practiceMode === 'candidate'));

  assert.deepEqual(migrated.matches[completedMatch.id], completedMatch, 'completed interview history is unchanged');
  assert.equal(migrated.matches['active-peer-room'].status, 'expired', 'an unfinished legacy peer session cannot be reopened');
  assert.ok(Number.isFinite(Date.parse(migrated.matches['active-peer-room'].expiredAt)));
  assert.deepEqual(migrated.notifications, legacyState.notifications, 'unrelated persisted account data is retained');
});
