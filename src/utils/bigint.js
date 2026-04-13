function replacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

function bigintJsonMiddleware(_req, res, next) {
  const oldJson = res.json;
  res.json = function (data) {
    return oldJson.call(this, JSON.parse(JSON.stringify(data, replacer)));
  };
  next();
}

module.exports = { bigintJsonMiddleware, replacer };