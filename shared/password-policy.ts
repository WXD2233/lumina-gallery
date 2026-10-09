import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.ts';

// This deliberately small local list catches common choices without sending a
// password to a third-party service or rejecting words inside a longer phrase.
const commonWords = [
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'p4ssword', 'p4ssw0rd',
  'admin', 'administrator', 'letmein', 'welcome', 'changeme', 'iloveyou',
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'abc123',
];
const simpleDecoration = /^[\p{N}\p{P}\p{S}\p{Z}]*$/u;
const sequenceAlphabets = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];

function isSequence(value: string, alphabet: string): boolean {
  if (value.length < 8) return false;
  const start = alphabet.indexOf(value[0]);
  if (start < 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== alphabet[(start + index) % alphabet.length]) return false;
  }
  return true;
}

function hasShortRepeatedPattern(value: string): boolean {
  if (!value) return false;
  // A short repeating fragment does not become strong simply by being longer.
  for (let length = 1; length <= Math.min(8, Math.floor(value.length / 2)); length++) {
    if (value.length % length === 0 && value === value.slice(0, length).repeat(value.length / length)) return true;
  }
  return false;
}

/** Validate newly chosen passwords only. Existing-password login is unchanged. */
export function validateNewPassword(password: unknown, username: string): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`密码需要 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`);
  }
  if (!password.trim()) throw new Error('密码不能全部为空格');

  // Normalize for weakness comparisons only; the original password is returned
  // and hashed exactly as entered, including spaces and Unicode characters.
  const comparison = password.normalize('NFKC').toLowerCase().trim();
  const account = username.normalize('NFKC').toLowerCase().trim();
  if (account && comparison.includes(account)) {
    const before = comparison.slice(0, comparison.indexOf(account));
    const after = comparison.slice(comparison.indexOf(account) + account.length);
    if (simpleDecoration.test(before) && simpleDecoration.test(after)) {
      throw new Error('密码不能只是账号或账号加数字、符号，请使用独立的长密码');
    }
  }

  const compact = comparison.replace(/[^\p{L}\p{N}]/gu, '');
  if (hasShortRepeatedPattern(comparison) || (compact.length > 0 && hasShortRepeatedPattern(compact))) {
    throw new Error('密码过于简单，请避免重复字符或重复的短片段');
  }
  if (compact.length > 0 && sequenceAlphabets.some(alphabet => isSequence(compact, alphabet) || isSequence(compact, [...alphabet].reverse().join('')))) {
    throw new Error('密码过于简单，请避免连续数字、字母或键盘顺序');
  }
  if (commonWords.some(word => {
    const index = comparison.indexOf(word);
    return index >= 0 && simpleDecoration.test(comparison.slice(0, index)) && simpleDecoration.test(comparison.slice(index + word.length));
  })) {
    throw new Error('这是常见的弱密码，请换成长密码短语或密码管理器生成的密码');
  }
  return password;
}
