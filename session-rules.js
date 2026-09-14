const PRACTICE_MODES = ['peer', 'candidate', 'interviewer'];
const CANDIDATE_CRITERIA = ['Problem solving', 'Communication', 'Technical depth'];
const INTERVIEWER_CRITERIA = ['Question clarity', 'Guidance', 'Professionalism'];
const SESSION_DURATION_MS = 45 * 60 * 1000;
const PEER_SWITCH_MS = Math.floor(SESSION_DURATION_MS / 2);
// Kept as an export for older integrations; peer mode now switches halfway through a 45-minute session.
const HALF_SESSION_MS = PEER_SWITCH_MS;

function practiceMode(profile) {
  return PRACTICE_MODES.includes(profile?.practiceMode) ? profile.practiceMode : 'peer';
}

function compatibleModes(first, second) {
  const a = practiceMode(first), b = practiceMode(second);
  return (a === 'peer' && b === 'peer') || (a === 'candidate' && b === 'interviewer') || (a === 'interviewer' && b === 'candidate');
}

function sessionMode(match) {
  return match.people?.some(person => practiceMode(person) !== 'peer') ? 'directed' : 'peer';
}

function sessionDetails(match, email, now = Date.now()) {
  const person = match.people.find(item => item.email === email);
  const peer = match.people.find(item => item.email !== email);
  const mode = sessionMode(match);
  const started = Date.parse(match.sessionStartedAt);
  const phase = mode === 'peer' && Number.isFinite(started) && now - started >= PEER_SWITCH_MS ? 2 : 1;
  const startsAsInterviewer = mode === 'directed' ? practiceMode(person) === 'interviewer' : match.people[0].email === email;
  const isInterviewer = phase === 2 ? !startsAsInterviewer : startsAsInterviewer;
  return {
    practiceMode: practiceMode(person),
    sessionMode: mode,
    durationMinutes: 45,
    startsAsInterviewer,
    initiator: match.people[0].email === email,
    role: isInterviewer ? 'interviewer' : 'candidate',
    peerRole: mode === 'peer' ? 'peer' : practiceMode(peer),
    phase,
    startedAt: match.sessionStartedAt || null,
    serverNow: new Date(now).toISOString(),
    feedbackCriteria: [...(practiceMode(peer) === 'interviewer' ? INTERVIEWER_CRITERIA : CANDIDATE_CRITERIA)],
    receivedFeedbackCriteria: [...(practiceMode(person) === 'interviewer' ? INTERVIEWER_CRITERIA : CANDIDATE_CRITERIA)]
  };
}

function currentQuestion(match, email, now = Date.now(), fallback = {}) {
  const viewer = sessionDetails(match, email, now);
  const interviewer = match.people.find(person => sessionDetails(match, person.email, now).role === 'interviewer');
  const question = match.questions?.[interviewer?.email] || fallback;
  const result = { title: question.title || '', prompt: question.prompt || '', starter: question.starter || '' };
  if (viewer.role === 'interviewer') result.hints = [...(question.hints || [])];
  return result;
}

function isParticipant(match, email) {
  return Boolean(match?.people?.some(person => person.email === email));
}

function canUseRoom(match, email, joined, action = 'collaborate') {
  if (!isParticipant(match, email)) return false;
  if (action === 'feedback') return match.status === 'feedback_pending';
  if (action === 'cancel') return match.status === 'matched';
  if (action === 'finish') return joined && match.status === 'in_progress';
  return joined && ['matched', 'in_progress'].includes(match.status);
}

function validFeedback(input, criteria, now = Date.now()) {
  if (!input || !Array.isArray(input.scores) || input.scores.length !== 3 || input.scores.some(score => !Number.isInteger(score) || score < 1 || score > 5)) return null;
  const strength = String(input.strength || '').trim().slice(0, 1200);
  const improve = String(input.improve || '').trim().slice(0, 1200);
  if (strength.length < 5 || improve.length < 5 || typeof input.practiseAgain !== 'boolean') return null;
  return { scores: [...input.scores], criteria: [...criteria], strength, improve, practiseAgain: input.practiseAgain, submittedAt: new Date(now).toISOString() };
}

function feedbackWithCriteria(match, authorEmail) {
  const feedback = match.feedback?.[authorEmail];
  return feedback ? { ...feedback, criteria: sessionDetails(match, authorEmail).feedbackCriteria } : null;
}

function finishFeedback(match, profiles, now = Date.now()) {
  if (match.status !== 'feedback_pending' || match.completedAt || !match.people.every(person => match.feedback?.[person.email])) return false;
  match.status = 'completed';
  match.completedAt = new Date(now).toISOString();
  match.people.forEach(person => {
    const other = match.people.find(candidate => candidate.email !== person.email);
    const received = match.feedback[other.email];
    const profile = profiles[person.email] || (profiles[person.email] = { ...person });
    const average = received.scores.reduce((sum, score) => sum + score, 0) / received.scores.length;
    const stats = profile.stats || {};
    const sessionsCompleted = (Number(stats.sessionsCompleted) || 0) + 1;
    const ratingTotal = (Number(stats.ratingTotal) || 0) + average;
    profile.stats = { ...stats, sessionsCompleted, ratingTotal, averageRating: ratingTotal / sessionsCompleted };
    profile.status = 'idle';
  });
  return true;
}

module.exports = { PRACTICE_MODES, SESSION_DURATION_MS, PEER_SWITCH_MS, HALF_SESSION_MS, practiceMode, compatibleModes, sessionMode, sessionDetails, currentQuestion, isParticipant, canUseRoom, validFeedback, feedbackWithCriteria, finishFeedback };
