function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || null;
}

async function writeAuditLog(db, req, params) {
  const actorUserId = req.user?.sub ?? null;
  const actorRole = req.user?.role ?? null;
  const actorHostelId = req.user?.hostelId ?? null;

  const ipAddress = getClientIp(req);
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;

  await db.execute(
    `INSERT INTO audit_logs
      (actor_user_id, actor_role, actor_hostel_id, action, entity_type, entity_id, details, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actorUserId,
      actorRole,
      actorHostelId,
      params.action,
      params.entityType || null,
      params.entityId ?? null,
      params.details ? JSON.stringify(params.details) : null,
      ipAddress,
      userAgent ? String(userAgent).slice(0, 255) : null,
    ],
  );
}

module.exports = {
  writeAuditLog,
};

