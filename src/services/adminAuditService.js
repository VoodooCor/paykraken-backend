function getRequestIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }

  return (
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
}

async function createAdminAudit(prisma, params) {
  const {
    req,
    actorType = 'API_KEY',
    actorId = null,
    actorLabel = null,
    action,
    targetType = null,
    targetId = null,
    meta = null
  } = params;

  return prisma.adminAction.create({
    data: {
      actorType,
      actorId,
      actorLabel,
      action,
      targetType,
      targetId: targetId != null ? String(targetId) : null,
      ip: getRequestIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: meta || undefined
    }
  });
}

module.exports = {
  createAdminAudit,
  getRequestIp
};