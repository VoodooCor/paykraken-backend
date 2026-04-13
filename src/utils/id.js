const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // без I/O
const DIGITS = '0123456789';

function rnd(n, dict) {
  let s = '';
  for (let i = 0; i < n; i++) s += dict[Math.floor(Math.random() * dict.length)];
  return s;
}

function generateExternalId() {
  // Формат: AAAA-#####-AAAAA
  return `${rnd(4, ALPH)}-${rnd(5, DIGITS)}-${rnd(5, ALPH)}`;
}

module.exports = { generateExternalId };