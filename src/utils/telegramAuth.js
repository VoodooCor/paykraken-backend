const crypto = require("crypto");

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || typeof initData !== "string") {
    throw new Error("Missing Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Missing Telegram hash");
  }

  params.delete("hash");

  const authDate = Number(params.get("auth_date") || "0");
  const now = Math.floor(Date.now() / 1000);

  if (!authDate || now - authDate > maxAgeSeconds) {
    throw new Error("Telegram initData expired");
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const actualBuf = Buffer.from(hash, "hex");
  const expectedBuf = Buffer.from(expectedHash, "hex");

  if (
    actualBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(actualBuf, expectedBuf)
  ) {
    throw new Error("Invalid Telegram initData");
  }

  const userJson = params.get("user");
  const telegramUser = userJson ? JSON.parse(userJson) : null;

  if (!telegramUser || !telegramUser.id) {
    throw new Error("Telegram user not found in initData");
  }

  return {
    telegramUser,
    authDate,
    raw: Object.fromEntries(params.entries()),
  };
}

module.exports = {
  validateTelegramInitData,
};