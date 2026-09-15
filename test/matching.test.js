const test = require('node:test');
const assert = require('node:assert/strict');
const { compatibility, questionFor } = require('../server');

const base = {
  practiceMode: 'candidate',
  languages: ['JavaScript', 'React'],
  slots: ['2026-09-10T10:00:00.000Z'],
  interviewType: 'Frontend',
  experience: 'Intermediate',
  spokenLanguage: 'English'
};
const interviewer = changes => ({ ...base, practiceMode: 'interviewer', ...changes });

test('a compatible candidate and interviewer receive an explained score', () => {
  const result = compatibility(base, interviewer({ languages: ['JavaScript', 'React', 'Node.js'] }));
  assert.equal(result.value, 90);
  assert.deepEqual(result.commonSkills, ['JavaScript', 'React']);
  assert.equal(result.sharedSlot, base.slots[0]);
});

test('different UTC slots are never matched', () => {
  assert.equal(compatibility(base, interviewer({ slots: ['2026-09-10T12:00:00.000Z'] })), null);
});

test('different interview types are never matched', () => {
  assert.equal(compatibility(base, interviewer({ interviewType: 'Backend' })), null);
});

test('incompatible conversation languages are never matched', () => {
  assert.equal(compatibility(base, interviewer({ spokenLanguage: 'Hindi' })), null);
});

test('same roles and removed peer roles are never matched', () => {
  assert.equal(compatibility(base, { ...base }), null);
  assert.equal(compatibility({ ...base, practiceMode: 'peer' }, { ...base, practiceMode: 'peer' }), null);
});

test('each supported interview type has a local question', () => {
  for (const type of ['Data Structures & Algorithms', 'Frontend', 'Backend', 'System Design', 'Behavioral', 'SQL']) {
    assert.ok(questionFor(type, 0).prompt);
  }
});
