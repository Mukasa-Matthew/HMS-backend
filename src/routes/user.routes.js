const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { hashPassword, comparePassword } = require('../utils/password.util');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

const createUserSchema = Joi.object({
  username: Joi.string().max(100).required(),
  password: Joi.string().min(6).max(128).required(),
  role: Joi.string().valid('SUPER_ADMIN', 'CUSTODIAN', 'HOSTEL_OWNER').required(),
  hostelId: Joi.number().integer().optional(), // business rules enforced below
  isActive: Joi.boolean().default(true),
});

// Super Admin / Hostel Owner: create users
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = createUserSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { username, password, role, isActive, hostelId } = value;
      const db = getDb();
      const callerRole = req.user.role;
      const callerHostelId = req.user.hostelId || null;

      // Determine effective hostel id for the new user based on caller role and requested role
      let effectiveHostelId = null;

      if (callerRole === 'SUPER_ADMIN') {
        if (role === 'SUPER_ADMIN') {
          effectiveHostelId = null;
        } else {
          if (!hostelId) {
            return res
              .status(400)
              .json({ error: 'hostelId is required when creating Hostel Owner or Custodian' });
          }
          const [hostelRows] = await db.execute(
            'SELECT id FROM hostels WHERE id = ? LIMIT 1',
            [hostelId],
          );
          if (!hostelRows.length) {
            return res.status(400).json({ error: 'Invalid hostelId' });
          }
          effectiveHostelId = hostelId;
        }
      } else if (callerRole === 'HOSTEL_OWNER') {
        if (role !== 'CUSTODIAN') {
          return res
            .status(403)
            .json({ error: 'Hostel Owner can only create custodians for their hostel' });
        }
        if (!callerHostelId) {
          return res.status(400).json({ error: 'Hostel Owner is not linked to a hostel' });
        }
        effectiveHostelId = callerHostelId;
      }

      const [roleRows] = await db.execute('SELECT id FROM roles WHERE name = ? LIMIT 1', [
        role,
      ]);
      if (!roleRows.length) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      const passwordHash = await hashPassword(password);

      await db.execute(
        'INSERT INTO users (username, phone, password_hash, role_id, hostel_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        [username, username, passwordHash, roleRows[0].id, effectiveHostelId, isActive ? 1 : 0],
      );

      await writeAuditLog(db, req, {
        action: 'USER_CREATED',
        entityType: 'user',
        details: { username, role, hostelId: effectiveHostelId, isActive: isActive ? 1 : 0 },
      });

      return res.status(201).json({ message: 'User created' });
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      return next(err);
    }
  },
);

// Super Admin / Hostel Owner: list users (scoped by hostel)
router.get(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let rows;
      if (req.user.role === 'SUPER_ADMIN') {
        [rows] = await db.execute(
          'SELECT u.id, u.username, u.is_active, r.name AS role, u.hostel_id FROM users u JOIN roles r ON u.role_id = r.id ORDER BY u.id DESC',
        );
      } else {
        // Hostel owner / Custodian: only users in their hostel
        if (!req.user.hostelId) {
          return res.json([]);
        }
        [rows] = await db.execute(
          'SELECT u.id, u.username, u.is_active, r.name AS role, u.hostel_id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.hostel_id = ? ORDER BY u.id DESC',
          [req.user.hostelId],
        );
      }
      return res.json(rows);
    } catch (err) {
      return next(err);
    }
  },
);

// Get current user profile
router.get(
  '/me',
  authenticateToken,
  async (req, res, next) => {
    try {
      const db = getDb();
      const userId = req.user.sub || req.user.id;
      if (!userId) {
        return res.status(400).json({ error: 'User ID not found in token' });
      }
      const [rows] = await db.execute(
        'SELECT u.id, u.username, u.phone, r.name AS role, u.hostel_id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? LIMIT 1',
        [userId],
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.json(rows[0]);
    } catch (err) {
      return next(err);
    }
  },
);

// Update current user profile
const updateProfileSchema = Joi.object({
  username: Joi.string().max(100).optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
  currentPassword: Joi.string().min(6).max(128).optional(),
  newPassword: Joi.string().min(6).max(128).optional(),
}).or('username', 'phone', 'newPassword'); // At least one field must be provided

router.put(
  '/me',
  authenticateToken,
  async (req, res, next) => {
    try {
      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { username, phone, currentPassword, newPassword } = value;
      const db = getDb();
      const userId = req.user.sub || req.user.id;
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID not found in token' });
      }

      // Get current user data
      const [userRows] = await db.execute(
        'SELECT u.id, u.username, u.phone, u.password_hash, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? LIMIT 1',
        [userId],
      );
      if (!userRows.length) {
        return res.status(404).json({ error: 'User not found' });
      }

      const currentUser = userRows[0];
      const updates = [];
      const params = [];

      // Update username if provided
      if (username && username !== currentUser.username) {
        // Check if username already exists
        const [existingRows] = await db.execute(
          'SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1',
          [username, userId],
        );
        if (existingRows.length > 0) {
          return res.status(409).json({ error: 'Username already exists' });
        }
        updates.push('username = ?');
        params.push(username);
      }

      // Update phone if provided
      if (phone !== undefined && phone !== currentUser.phone) {
        updates.push('phone = ?');
        params.push(phone === '' ? null : phone);
      }

      // Update password if provided
      if (newPassword) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password is required to change password' });
        }
        // Verify current password
        const isPasswordValid = await comparePassword(currentPassword, currentUser.password_hash);
        if (!isPasswordValid) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
        // Hash new password
        const newPasswordHash = await hashPassword(newPassword);
        updates.push('password_hash = ?');
        params.push(newPasswordHash);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No changes provided' });
      }

      // Execute update
      params.push(userId);
      await db.execute(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        params,
      );

      // Get updated user data
      const [updatedRows] = await db.execute(
        'SELECT u.id, u.username, u.phone, r.name AS role, u.hostel_id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? LIMIT 1',
        [userId],
      );

      await writeAuditLog(db, req, {
        action: 'PROFILE_UPDATED',
        entityType: 'user',
        entityId: userId,
        details: {
          updatedFields: updates,
          username: username || currentUser.username,
        },
      });

      return res.json({
        message: 'Profile updated successfully',
        user: updatedRows[0],
      });
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Username already exists' });
      }
      return next(err);
    }
  },
);

module.exports = router;

