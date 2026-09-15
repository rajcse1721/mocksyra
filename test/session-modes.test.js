const test = require('node:test');
const assert = require('node:assert/strict');
const { compatibility, publicMatch, historyFor, app } = require('../server');
const { compatibleModes, sessionDetails, currentQuestion, canUseRoom, validFeedback, finishFeedback } = require('../session-rules');

const first = { email: 'candidate@example.test', name: 'Ada', languages: ['JavaScript'], slots: ['2030-01-01T10:00:00.000Z'], interviewType: 'Frontend', experience: 'Intermediate', spokenLanguage: 'English' };
const second = { ...first, email: 'interviewer@example.test', name: 'Sam' };
const started = Date.parse('2030-01-01T10:00:00.000Z');
const questions = {
  [first.email]: { title: 'First question', prompt: 'Solve question one.', starter: '// Start one', hints: ['Private hint one'] },
  [second.email]: { title: 'Second question', prompt: 'Solve question two.', starter: '// Start two', hints: ['Private hint two'] }
};

function interview(mode = 'directed', status = 'matched') {
  return {
    id: 'sample-room', status,
    people: [{ ...first, practiceMode: 'candidate' }, { ...second, practiceMode: 'interviewer' }],
    questions, interviewType: 'Frontend', sharedSlot: first.slots[0], score: 80, feedback: {}
  };
}

test('only candidate and interviewer are complementary roles', () => {
  const allowed = new Set(['candidate:interviewer', 'interviewer:candidate']);
  for (const a of ['candidate', 'interviewer']) {
    for (const b of ['candidate', 'interviewer']) {
      const expected = allowed.has(`${a}:${b}`);
      assert.equal(compatibleModes({ practiceMode: a }, { practiceMode: b }), expected, `${a} + ${b}`);
      assert.equal(Boolean(compatibility({ ...first, practiceMode: a }, { ...second, practiceMode: b })), expected);
    }
  }
  assert.equal(compatibility({ ...first, practiceMode: 'peer' }, { ...second, practiceMode: 'peer' }), null);
  assert.equal(compatibility(first, { ...second, practiceMode: 'interviewer' }), null, 'new matches require an explicit role');
});

test('directed candidate may initiate WebRTC while interviewer retains the interviewer role', () => {
  const match = interview('directed', 'in_progress');
  match.sessionStartedAt = new Date(started).toISOString();
  const candidate = publicMatch(match, first.email, started);
  const interviewer = publicMatch(match, second.email, started);
  assert.equal(candidate.initiator, true);
  assert.equal(candidate.startsAsInterviewer, false);
  assert.equal(interviewer.initiator, false);
  assert.equal(interviewer.startsAsInterviewer, true);
  assert.equal(candidate.sessionMode, 'directed');
  assert.equal(candidate.durationMinutes, 45);
  assert.equal(candidate.peerRole, 'interviewer');
  assert.equal(interviewer.peerRole, 'candidate');
  assert.deepEqual(candidate.feedbackCriteria, ['Question clarity', 'Guidance', 'Professionalism']);
  assert.deepEqual(interviewer.feedbackCriteria, ['Problem solving', 'Communication', 'Technical depth']);
  assert.equal(sessionDetails(match, first.email, started + 60 * 60 * 1000).role, 'candidate', 'directed sessions never swap roles');
  assert.equal(sessionDetails(match, second.email, started + 60 * 60 * 1000).phase, 1);
});

test('candidates see the active shared prompt without interviewer hints', () => {
  const match = interview('directed');
  const candidate = publicMatch(match, first.email, started);
  const interviewer = publicMatch(match, second.email, started);
  assert.equal(candidate.question.prompt, interviewer.question.prompt);
  assert.equal(candidate.question.prompt, questions[second.email].prompt);
  assert.equal(Object.hasOwn(candidate.question, 'hints'), false);
  assert.deepEqual(interviewer.question.hints, ['Private hint two']);
  assert.equal(Object.hasOwn(questions[second.email], 'hints'), true, 'filtering never changes stored questions');
});

test('candidate and interviewer roles remain fixed for all 45 minutes', () => {
  const match = interview('directed', 'in_progress');
  match.sessionStartedAt = new Date(started).toISOString();
  assert.equal(publicMatch(match, first.email, started).practiceMode, 'candidate');
  assert.equal(publicMatch(match, first.email, started).durationMinutes, 45);
  assert.equal(sessionDetails(match, first.email, started + 44 * 60 * 1000).role, 'candidate');
  assert.equal(sessionDetails(match, second.email, started + 44 * 60 * 1000).role, 'interviewer');
  assert.equal(currentQuestion(match, first.email, started + 44 * 60 * 1000).prompt, questions[second.email].prompt);
  assert.equal(currentQuestion(match, first.email, started + 44 * 60 * 1000).hints, undefined);
  assert.deepEqual(currentQuestion(match, second.email, started + 44 * 60 * 1000).hints, ['Private hint two']);
});

test('match without question or feedback records still restores safely', () => {
  const match = interview('directed');
  delete match.questions;
  delete match.feedback;
  const result = publicMatch(match, second.email);
  assert.equal(result.practiceMode, 'interviewer');
  assert.equal(result.feedbackSubmitted, false);
  assert.equal(result.selfFeedback, null);
  assert.ok(result.question.prompt);
  assert.ok(result.question.hints.length);
});

test('scheduled rooms open ten minutes early without leaking hosted-video credentials', () => {
  const match = interview('directed');
  match.mediaProvider = 'daily';
  const elevenMinutesEarly = started - 11 * 60 * 1000;
  const tenMinutesEarly = started - 10 * 60 * 1000;
  const early = publicMatch(match, first.email, elevenMinutesEarly);
  const open = publicMatch(match, first.email, tenMinutesEarly);
  assert.equal(early.canJoinNow, false);
  assert.equal(open.canJoinNow, true);
  assert.equal(open.videoProvider, 'daily');
  assert.equal(Object.hasOwn(open, 'token'), false);
  assert.equal(Object.hasOwn(open, 'roomUrl'), false);
});

const feedbackInput = { scores: [5, 4, 3], strength: 'Clear examples.', improve: 'Explain each step.', practiseAgain: true };
test('feedback validates each score and does not silently turn invalid values into ratings', () => {
  const criteria = ['Question clarity', 'Guidance', 'Professionalism'];
  assert.deepEqual(validFeedback(feedbackInput, criteria).scores, [5, 4, 3]);
  assert.deepEqual(validFeedback(feedbackInput, criteria).criteria, criteria);
  assert.equal(validFeedback({ ...feedbackInput, practiseAgain: false }, criteria).practiseAgain, false);
  for (const score of [0, -1, 6, 1.5, NaN, Infinity, '4', null, undefined]) {
    assert.equal(validFeedback({ ...feedbackInput, scores: [score, 4, 3] }, criteria), null);
  }
  for (const scores of [[], [5], [5, 4], [5, 4, 3, 2]]) assert.equal(validFeedback({ ...feedbackInput, scores }, criteria), null);
  assert.equal(validFeedback({ ...feedbackInput, strength: 'ok' }, criteria), null);
  assert.equal(validFeedback({ ...feedbackInput, practiseAgain: null }, criteria), null);
});

test('room permissions reject outsiders, clients that have not joined, and closed room mutations', () => {
  for (const status of ['matched', 'in_progress', 'feedback_pending', 'completed', 'cancelled']) {
    const match = interview('directed', status);
    for (const action of ['collaborate', 'finish', 'feedback', 'cancel']) assert.equal(canUseRoom(match, 'outsider@example.test', true, action), false);
    assert.equal(canUseRoom(match, first.email, false, 'collaborate'), false);
    assert.equal(canUseRoom(match, first.email, true, 'collaborate'), ['matched', 'in_progress'].includes(status));
    assert.equal(canUseRoom(match, first.email, true, 'finish'), status === 'in_progress');
    assert.equal(canUseRoom(match, first.email, false, 'finish'), false);
    assert.equal(canUseRoom(match, first.email, false, 'feedback'), status === 'feedback_pending');
    assert.equal(canUseRoom(match, first.email, false, 'cancel'), status === 'matched');
  }
  assert.equal(canUseRoom(null, first.email, true), false);
});

test('mutual feedback completes once, updates both histories and preserves role-specific criteria', () => {
  const match = interview('directed', 'feedback_pending');
  const profiles = Object.fromEntries(match.people.map(person => [person.email, { ...person }]));
  match.feedback[first.email] = validFeedback(feedbackInput, sessionDetails(match, first.email).feedbackCriteria);
  match.feedback.undefined = { scores: [5, 5, 5] };
  assert.equal(finishFeedback(match, profiles, started), false, 'an old unidentified submission cannot release feedback');
  assert.equal(profiles[first.email].stats, undefined);
  const restored = publicMatch(match, first.email);
  assert.equal(restored.feedbackSubmitted, true);
  assert.deepEqual(restored.selfFeedback.scores, feedbackInput.scores);
  assert.equal(Object.hasOwn(restored, 'feedbackReceived'), false);
  match.feedback[second.email] = validFeedback({ ...feedbackInput, scores: [3, 3, 3] }, sessionDetails(match, second.email).feedbackCriteria);
  assert.equal(finishFeedback(match, profiles, started), true);
  assert.equal(finishFeedback(match, profiles, started), false);
  assert.equal(profiles[first.email].stats.sessionsCompleted, 1);
  assert.equal(profiles[first.email].stats.averageRating, 3);
  assert.equal(profiles[second.email].stats.averageRating, 4);
  const candidateHistory = historyFor(first.email, { sample: match });
  const interviewerHistory = historyFor(second.email, { sample: match });
  assert.equal(candidateHistory[0].durationMinutes, 45);
  assert.equal(candidateHistory[0].practiceMode, 'candidate');
  assert.equal(interviewerHistory[0].practiceMode, 'interviewer');
  assert.deepEqual(candidateHistory[0].feedbackReceived.criteria, ['Problem solving', 'Communication', 'Technical depth']);
  assert.deepEqual(interviewerHistory[0].feedbackReceived.criteria, ['Question clarity', 'Guidance', 'Professionalism']);
  assert.equal(historyFor('outsider@example.test', { sample: match }).length, 0);
});

test('public HTTP server serves browser assets while private files return 404', async t => {
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  for (const route of ['/', '/app.js', '/styles.css', '/health']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200, route);
    await response.text();
  }
  for (const route of ['/data/mocksyra.json', '/data/notification-outbox.jsonl', '/server.js', '/session-rules.js', '/package.json', '/.env', '/supabase-schema.sql', '/test/matching.test.js']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), 'Not found');
  }
});
