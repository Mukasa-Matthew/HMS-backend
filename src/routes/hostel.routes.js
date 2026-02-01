const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');
const { hashPassword } = require('../utils/password.util');

const router = express.Router();

const hostelSchema = Joi.object({
  name: Joi.string().max(150).required(),
  location: Joi.string().max(255).allow(null, ''),
  contactPhone: Joi.string().max(30).allow(null, ''),
  ownerFullName: Joi.string().max(150).required(),
  ownerPhone: Joi.string().max(30).required(),
  ownerEmail: Joi.string().email().max(150).allow(null, ''),
  ownerUsername: Joi.string().max(100).required(),
  ownerPassword: Joi.string().min(6).max(128).required(),
});

// Super Admin: create hostels
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN']),
  async (req, res, next) => {
    try {
      const { error, value } = hostelSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const {
        name,
        location,
        contactPhone,
        ownerFullName,
        ownerPhone,
        ownerEmail,
        ownerUsername,
        ownerPassword,
      } = value;
      const pool = getDb();
      const conn = await pool.getConnection();

      try {
        await conn.beginTransaction();

        const [hostelRes] = await conn.execute(
          'INSERT INTO hostels (name, location, contact_phone) VALUES (?, ?, ?)',
          [name, location || null, contactPhone || null],
        );
        const hostelId = hostelRes.insertId;

        const [roleRows] = await conn.execute(
          'SELECT id FROM roles WHERE name = ? LIMIT 1',
          ['HOSTEL_OWNER'],
        );
        if (!roleRows.length) {
          throw new Error('HOSTEL_OWNER role not found');
        }
        const roleId = roleRows[0].id;

        const passwordHash = await hashPassword(ownerPassword);

        const [ownerRes] = await conn.execute(
          'INSERT INTO users (username, phone, password_hash, role_id, hostel_id, is_active) VALUES (?, ?, ?, ?, ?, 1)',
          [ownerUsername, ownerPhone, passwordHash, roleId, hostelId],
        );
        const ownerUserId = ownerRes.insertId;

        await conn.commit();

        await writeAuditLog(pool, req, {
          action: 'HOSTEL_AND_OWNER_CREATED',
          entityType: 'hostel',
          entityId: hostelId,
          details: {
            hostelId,
            name,
            location: location || null,
            contactPhone: contactPhone || null,
            ownerUserId,
            ownerFullName,
            ownerPhone,
            ownerEmail: ownerEmail || null,
          },
        });

        return res
          .status(201)
          .json({ message: 'Hostel and owner created', hostelId, ownerUserId });
      } catch (err) {
        try {
          await conn.rollback();
        } catch (_) {
          // ignore rollback errors
        }
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      return next(err);
    }
  },
);

// List hostels
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();

    if (req.user.role === 'SUPER_ADMIN') {
      const [rows] = await db.execute(
        'SELECT id, name, location, contact_phone, is_active, created_at FROM hostels ORDER BY name',
      );
      return res.json(rows);
    }

    // Owners / custodians only see their own hostel
    if (!req.user.hostelId) {
      return res.json([]);
    }

    const [rows] = await db.execute(
      'SELECT id, name, location, contact_phone, is_active, created_at FROM hostels WHERE id = ? LIMIT 1',
      [req.user.hostelId],
    );
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

