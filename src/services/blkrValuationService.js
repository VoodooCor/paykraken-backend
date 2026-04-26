const DEXSCREENER_API_BASE = 'https://api.dexscreener.com/latest/dex/pairs';
const CBR_DAILY_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

const DEFAULT_CHAIN_ID = process.env.BLKR_DEX_CHAIN_ID || 'solana';
const DEFAULT_PAIR_ID =
  process.env.BLKR_DEX_PAIR_ID || '2hbyecjis66vyyokdr6buze5fddqzdeffpbahit8zks9';

const DEFAULT_DISPLAY_AMOUNT = Number(process.env.BLKR_DISPLAY_AMOUNT || '200000000');

const cache = {
  token: {
    value: null,
    fetchedAt: 0
  },
  rub: {
    value: null,
    fetchedAt: 0
  }
};

const TOKEN_TTL_MS = 30 * 1000;
const RUB_TTL_MS = 60 * 60 * 1000;

function ensurePositiveNumber(value, fieldName) {
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }

  return num;
}

function formatInteger(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0
  }).format(Number(value));
}

function formatUsdt(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(Number(value));
}

function formatRub(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value));
}

async function fetchPairPriceUsd() {
  const url = `${DEXSCREENER_API_BASE}/${DEFAULT_CHAIN_ID}/${DEFAULT_PAIR_ID}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`DexScreener error: ${response.status}`);
  }

  const data = await response.json();
  const pair = data?.pair;

  if (!pair) {
    throw new Error('DexScreener pair not found');
  }

  const priceUsd = Number.parseFloat(pair.priceUsd);

  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error('Invalid BLKR priceUsd from DexScreener');
  }

  return {
    priceUsd,
    pairAddress: pair.pairAddress || DEFAULT_PAIR_ID,
    dexId: pair.dexId || null,
    url: pair.url || null,
    baseToken: pair.baseToken || null,
    quoteToken: pair.quoteToken || null
  };
}

async function fetchUsdRubRate() {
  const response = await fetch(CBR_DAILY_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`CBR error: ${response.status}`);
  }

  const data = await response.json();
  const usd = data?.Valute?.USD;
  const rate = Number.parseFloat(usd?.Value);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Invalid USD/RUB rate from CBR');
  }

  return {
    rate,
    date: data?.Date || null,
    previousDate: data?.PreviousDate || null
  };
}

async function getPairPriceUsd({ force = false } = {}) {
  const now = Date.now();

  if (!force && cache.token.value && now - cache.token.fetchedAt < TOKEN_TTL_MS) {
    return {
      ...cache.token.value,
      fetchedAt: cache.token.fetchedAt,
      source: 'dexscreener-cache'
    };
  }

  const value = await fetchPairPriceUsd();

  cache.token = {
    value,
    fetchedAt: now
  };

  return {
    ...value,
    fetchedAt: now,
    source: 'dexscreener'
  };
}

async function getUsdRubRate({ force = false } = {}) {
  const now = Date.now();

  if (!force && cache.rub.value && now - cache.rub.fetchedAt < RUB_TTL_MS) {
    return {
      ...cache.rub.value,
      fetchedAt: cache.rub.fetchedAt,
      source: 'cbr-cache'
    };
  }

  const value = await fetchUsdRubRate();

  cache.rub = {
    value,
    fetchedAt: now
  };

  return {
    ...value,
    fetchedAt: now,
    source: 'cbr'
  };
}

async function getBlkrValuation(amountBlkr = DEFAULT_DISPLAY_AMOUNT, options = {}) {
  const amount = ensurePositiveNumber(amountBlkr, 'amountBlkr');

  const [tokenPrice, rubRate] = await Promise.all([
    getPairPriceUsd(options),
    getUsdRubRate(options)
  ]);

  const totalUsdt = amount * tokenPrice.priceUsd;
  const totalRub = totalUsdt * rubRate.rate;

  return {
    amountBlkr: amount,
    defaults: {
      displayAmountBlkr: DEFAULT_DISPLAY_AMOUNT
    },
    pricePerBlkr: {
      usd: tokenPrice.priceUsd,
      usdtApprox: tokenPrice.priceUsd
    },
    totals: {
      usdt: totalUsdt,
      rub: totalRub
    },
    formatted: {
      blkr: `${formatInteger(amount)} BLKR`,
      usdt: `${formatUsdt(totalUsdt)} USDT`,
      rub: `≈ ${formatRub(totalRub)} ₽`
    },
    sources: {
      tokenPrice: {
        provider: 'DexScreener',
        chainId: DEFAULT_CHAIN_ID,
        pairAddress: tokenPrice.pairAddress,
        dexId: tokenPrice.dexId,
        url: tokenPrice.url,
        baseToken: tokenPrice.baseToken,
        quoteToken: tokenPrice.quoteToken,
        fetchedAt: new Date(tokenPrice.fetchedAt).toISOString(),
        source: tokenPrice.source
      },
      rubRate: {
        provider: 'CBR',
        usdRub: rubRate.rate,
        cbrDate: rubRate.date,
        previousDate: rubRate.previousDate,
        fetchedAt: new Date(rubRate.fetchedAt).toISOString(),
        source: rubRate.source
      }
    },
    approximate: true,
    note: 'USDT shown as approximation based on DexScreener USD price. RUB is calculated using official USD/RUB rate from CBR.'
  };
}

module.exports = {
  getBlkrValuation
};