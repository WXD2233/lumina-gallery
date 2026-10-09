import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNewPassword } from '../shared/password-policy.ts';

test('new passwords require 15–128 characters without trimming the actual value', () => {
  for (const value of [undefined, null, 123456789012345, {}, '', '              ', 'short password', 'a'.repeat(129)]) {
    assert.throws(() => validateNewPassword(value, 'owner'));
  }
  const password = '  river saffron compass velvet  ';
  assert.equal(validateNewPassword(password, 'owner'), password);
  assert.equal(validateNewPassword('t7*R2x!M9n$Q6v?', 'owner'), 't7*R2x!M9n$Q6v?');
});

test('new passwords reject common words with simple numeric and symbol decoration', () => {
  for (const value of ['password123456789', 'Password12345678!', '2026P@ssw0rd2026!', 'welcome123456789', 'qwerty123456789!', 'Ｐａｓｓｗｏｒｄ１２３４５６７８！']) {
    assert.throws(() => validateNewPassword(value, 'owner'), /常见的弱密码/, value);
  }
});

test('new passwords reject repeated fragments and numeric or keyboard sequences', () => {
  for (const value of ['aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaa!', 'abcabcabcabcabc', 'abcdabcdabcdabcd!', '123456789012345', '987654321098765', 'abcdefghijklmno', 'qwertyuiopasdfgh', ' 111111111111111 ']) {
    assert.throws(() => validateNewPassword(value, 'owner'), /过于简单/, value);
  }
});

test('new passwords cannot be only an account name with numbers and symbols', () => {
  for (const value of ['mygalleryaccount', 'MyGalleryAccount123!', '2026!MyGalleryAccount2026', '  mygalleryaccount  ']) {
    assert.throws(() => validateNewPassword(value, 'MyGalleryAccount'), /账号/, value);
  }
  assert.throws(() => validateNewPassword('小明1234567890123!', '小明'), /账号/);
});

test('independent symbols and emoji are allowed while repeated punctuation remains weak', () => {
  for (const value of ['!#%&?+-@$^*=~|_:', '🌊🍀🎨🌙🦋🍋🌸🪐']) {
    assert.equal(validateNewPassword(value, 'owner'), value);
  }
  for (const value of ['!!!!!!!!!!!!!!!!', '!@#!@#!@#!@#!@#', '🌙🌙🌙🌙🌙🌙🌙🌙']) {
    assert.throws(() => validateNewPassword(value, 'owner'), /过于简单/);
  }
});

test('new passwords accept long phrases, Unicode, spaces, and generated passwords without composition rules', () => {
  for (const value of [
    '我喜欢在秋天的傍晚沿着河岸慢慢散步',
    'river saffron compass velvet',
    'correct horse battery harvest',
    'passwords belong inside my vault',
    'owner collects sunset photographs',
    'K8y!wR2$zT9@hV6#jN4%bQ7',
    '!#%&?+-@$^*=~|_:',
    '984170682519736',
  ]) assert.equal(validateNewPassword(value, 'owner'), value);
});
