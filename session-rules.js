const PRACTICE_MODES = ['candidate', 'interviewer'];
const CANDIDATE_CRITERIA = ['Problem solving', 'Communication', 'Technical depth'];
const INTERVIEWER_CRITERIA = ['Question clarity', 'Guidance', 'Professionalism'];
const SESSION_DURATION_MS = 45 * 60 * 1000;

function practiceMode(profile) {
  return PRACTICE_MODES.includes(profile?.practiceMode) ? profile.practiceMode : null;
}

function compatibleModes(first, second) {
  const a = practiceMode(first), b = practiceMode(second);
  return (a === 'candidate' && b === 'interviewer') || (a === 'interviewer' && b === 'candidate');
}

function sessionMode(match) {
  return 'directed';
}

function sessionDetails(match, email, now = Date.now()) {
  const person = match.people.find(item => item.email === email);
  const peer = match.people.find(item => item.email !== email);
  const mode = sessionMode(match);
  const startsAsInterviewer = practiceMode(person) === 'interviewer';
  const isInterviewer = startsAsInterviewer;
  return {
    practiceMode: practiceMode(person),
    sessionMode: mode,
    durationMinutes: 45,
    startsAsInterviewer,
    initiator: match.people[0].email === email,
    role: isInterviewer ? 'interviewer' : 'candidate',
    peerRole: practiceMode(peer),
    phase: 1,
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
  if (!feedback) return null;
  const criteria = Array.isArray(feedback.criteria) && feedback.criteria.length === 3 ? feedback.criteria : sessionDetails(match, authorEmail).feedbackCriteria;
  return { ...feedback, criteria: [...criteria] };
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
  });
  return true;
}

module.exports = { PRACTICE_MODES, SESSION_DURATION_MS, practiceMode, compatibleModes, sessionMode, sessionDetails, currentQuestion, isParticipant, canUseRoom, validFeedback, feedbackWithCriteria, finishFeedback };
