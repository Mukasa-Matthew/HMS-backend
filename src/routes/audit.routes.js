const express = require('express');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');

const router = express.Router();

// Super Admin: see all audit logs
// Hostel Owner: see audit logs for their hostel only
router.get(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      const limit = Math.min(Number(req.query.limit || 200), 500) || 200;
      const offset = Math.max(Number(req.query.offset || 0), 0) || 0;
      const limitInt = Math.max(1, Math.floor(limit));
      const offsetInt = Math.max(0, Math.floor(offset));

      let rows;
      if (req.user.role === 'SUPER_ADMIN') {
        const sql = `SELECT id, actor_user_id, actor_role, actor_hostel_id, action, entity_type, entity_id, details, ip_address, user_agent, created_at
           FROM audit_logs
           ORDER BY id DESC
           LIMIT ${limitInt} OFFSET ${offsetInt}`;
        [rows] = await db.query(sql);
      } else {
        if (!req.user.hostelId) return res.json([]);
        const sql = `SELECT id, actor_user_id, actor_role, actor_hostel_id, action, entity_type, entity_id, details, ip_address, user_agent, created_at
           FROM audit_logs
           WHERE actor_hostel_id = ?
           ORDER BY id DESC
           LIMIT ${limitInt} OFFSET ${offsetInt}`;
        [rows] = await db.execute(sql, [req.user.hostelId]);
      }

      return res.json(rows);
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;

