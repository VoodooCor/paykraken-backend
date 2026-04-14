const crypto = require('crypto');

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '0123456789';

function rnd(n, dict) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += dict[crypto.randomInt(0, dict.length)];
  }
  return out;
}

function generateExternalId() {
  return `${rnd(4, ALPH)}-${rnd(5, DIGITS)}-${rnd(5, ALPH)}`;
}

module.exports = { generateExternalId };