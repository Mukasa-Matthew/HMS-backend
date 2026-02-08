const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

const semesterSchema = Joi.object({
  name: Joi.string().max(100).required(),
  startDate: Joi.date().required(),
  endDate: Joi.date().allow(null, ''),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
});

// Get all semesters for a hostel
router.get(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let rows;

      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          [rows] = await db.execute(
            `SELECT id, hostel_id, name, start_date, end_date, is_active, created_at
             FROM semesters
             WHERE hostel_id = ?
             ORDER BY start_date DESC, created_at DESC`,
            [hostelId]
          );
        } else {
          [rows] = await db.execute(
            `SELECT id, hostel_id, name, start_date, end_date, is_active, created_at
             FROM semesters
             ORDER BY start_date DESC, created_at DESC`
          );
        }
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        [rows] = await db.execute(
          `SELECT id, hostel_id, name, start_date, end_date, is_active, created_at
           FROM semesters
           WHERE hostel_id = ?
           ORDER BY start_date DESC, created_at DESC`,
          [req.user.hostelId]
        );
      }

      return res.json(rows);
    } catch (err) {
      return next(err);
    }
  },
);

// Get active semester for a hostel
router.get(
  '/active',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let row;

      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (!hostelId) {
          return res.status(400).json({ error: 'hostelId is required for SUPER_ADMIN' });
        }
        [row] = await db.execute(
          `SELECT id, hostel_id, name, start_date, end_date, is_active, created_at
           FROM semesters
           WHERE hostel_id = ? AND is_active = 1
           LIMIT 1`,
          [hostelId]
        );
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        [row] = await db.execute(
          `SELECT id, hostel_id, name, start_date, end_date, is_active, created_at
           FROM semesters
           WHERE hostel_id = ? AND is_active = 1
           LIMIT 1`,
          [req.user.hostelId]
        );
      }

      if (row.length === 0) {
        // Return null instead of 404 - this is a valid state (no active semester)
        return res.json(null);
      }

      return res.json(row[0]);
    } catch (err) {
      return next(err);
    }
  },
);

// Create a new semester
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const { error, value } = semesterSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { name, startDate, endDate, hostelId } = value;
      const db = getDb();

      // Determine hostel scope
      let effectiveHostelId = null;
      if (req.user.role === 'SUPER_ADMIN') {
        if (!hostelId) {
          return res.status(400).json({ error: 'hostelId is required' });
        }
        effectiveHostelId = hostelId;
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
      }

      // Insert new semester (initially inactive)
      // Note: Multiple inactive semesters are allowed, but only one active semester per hostel
      let result;
      try {
        [result] = await db.execute(
          'INSERT INTO semesters (hostel_id, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 0)',
          [effectiveHostelId, name, startDate, endDate || null]
        );
      } catch (err) {
        // Handle duplicate entry error (in case constraint still exists)
        if (err.code === 'ER_DUP_ENTRY' && err.message.includes('unique_active_semester')) {
          // This shouldn't happen for inactive semesters, but handle it gracefully
          return res.status(400).json({ 
            error: 'Unable to create semester. Please try again or contact support.' 
          });
        }
        throw err;
      }

      await writeAuditLog(db, req, {
        action: 'SEMESTER_CREATED',
        entityType: 'semester',
        entityId: result.insertId,
        details: { hostelId: effectiveHostelId, name, startDate, endDate },
      });

      return res.status(201).json({
        message: 'Semester created successfully',
        semesterId: result.insertId,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// Activate a semester (deactivates current active semester)
router.post(
  '/:semesterId/activate',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const semesterId = Number(req.params.semesterId);
      const db = getDb();

      // Verify semester exists and get hostel_id and is_active
      const [semesterRows] = await db.execute(
        'SELECT id, hostel_id, is_active FROM semesters WHERE id = ? LIMIT 1',
        [semesterId]
      );

      if (semesterRows.length === 0) {
        return res.status(404).json({ error: 'Semester not found' });
      }

      const semester = semesterRows[0];
      const effectiveHostelId = semester.hostel_id;

      // Check authorization
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(effectiveHostelId) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Semester does not belong to your hostel' });
        }
      }

      // IDEMPOTENCY: Check if semester is already active
      if (semester.is_active === 1) {
        // Check if there are other active semesters (shouldn't happen, but handle gracefully)
        const [otherActive] = await db.execute(
          'SELECT COUNT(*) AS count FROM semesters WHERE hostel_id = ? AND is_active = 1 AND id != ?',
          [effectiveHostelId, semesterId]
        );
        
        if (otherActive[0].count === 0) {
          return res.json({ 
            message: 'Semester is already active. This operation is idempotent.',
            alreadyActive: true
          });
        }
      }

      // Start transaction: deactivate current active semester, activate new one
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // Deactivate all semesters for this hostel
        await conn.execute(
          'UPDATE semesters SET is_active = 0 WHERE hostel_id = ?',
          [effectiveHostelId]
        );

        // Activate the selected semester
        await conn.execute(
          'UPDATE semesters SET is_active = 1 WHERE id = ?',
          [semesterId]
        );

        await conn.commit();

        await writeAuditLog(db, req, {
          action: 'SEMESTER_ACTIVATED',
          entityType: 'semester',
          entityId: semesterId,
          details: { hostelId: effectiveHostelId },
        });

        return res.json({ message: 'Semester activated successfully' });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } catch (err) {
      return next(err);
    }
  },
);

// Deactivate a semester
router.post(
  '/:semesterId/deactivate',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const semesterId = Number(req.params.semesterId);
      const db = getDb();

      // Verify semester exists and get hostel_id and is_active
      const [semesterRows] = await db.execute(
        'SELECT id, hostel_id, is_active FROM semesters WHERE id = ? LIMIT 1',
        [semesterId]
      );

      if (semesterRows.length === 0) {
        return res.status(404).json({ error: 'Semester not found' });
      }

      const semester = semesterRows[0];
      const effectiveHostelId = semester.hostel_id;

      // Check authorization
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(effectiveHostelId) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Semester does not belong to your hostel' });
        }
      }

      // IDEMPOTENCY: Check if semester is already inactive
      if (semester.is_active === 0) {
        return res.json({ 
          message: 'Semester is already inactive. This operation is idempotent.',
          alreadyInactive: true
        });
      }

      // Deactivate the semester
      await db.execute(
        'UPDATE semesters SET is_active = 0 WHERE id = ?',
        [semesterId]
      );

      await writeAuditLog(db, req, {
        action: 'SEMESTER_DEACTIVATED',
        entityType: 'semester',
        entityId: semesterId,
        details: { hostelId: effectiveHostelId },
      });

      return res.json({ message: 'Semester deactivated successfully' });
    } catch (err) {
      return next(err);
    }
  },
);

// Update a semester
router.put(
  '/:semesterId',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const semesterId = Number(req.params.semesterId);
      const { error, value } = semesterSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { name, startDate, endDate } = value;
      const db = getDb();

      // Verify semester exists and get hostel_id
      const [semesterRows] = await db.execute(
        'SELECT id, hostel_id, is_active FROM semesters WHERE id = ? LIMIT 1',
        [semesterId]
      );

      if (semesterRows.length === 0) {
        return res.status(404).json({ error: 'Semester not found' });
      }

      const semester = semesterRows[0];
      const effectiveHostelId = semester.hostel_id;

      // Check authorization
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(effectiveHostelId) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Semester does not belong to your hostel' });
        }
      }

      // Prevent editing active semester's dates (to maintain data integrity)
      // Allow name changes but warn about date changes
      if (semester.is_active === 1) {
        // Check if dates are being changed
        const [currentSemester] = await db.execute(
          'SELECT start_date, end_date FROM semesters WHERE id = ?',
          [semesterId]
        );
        const current = currentSemester[0];
        const startDateChanged = new Date(current.start_date).toISOString().split('T')[0] !== new Date(startDate).toISOString().split('T')[0];
        const endDateChanged = 
          (current.end_date ? new Date(current.end_date).toISOString().split('T')[0] : null) !== 
          (endDate ? new Date(endDate).toISOString().split('T')[0] : null);
        
        if (startDateChanged || endDateChanged) {
          return res.status(400).json({ 
            error: 'Cannot change dates of an active semester. Please deactivate it first.' 
          });
        }
      }

      // Update the semester
      await db.execute(
        'UPDATE semesters SET name = ?, start_date = ?, end_date = ? WHERE id = ?',
        [name, startDate, endDate || null, semesterId]
      );

      await writeAuditLog(db, req, {
        action: 'SEMESTER_UPDATED',
        entityType: 'semester',
        entityId: semesterId,
        details: { hostelId: effectiveHostelId, name, startDate, endDate },
      });

      return res.json({ message: 'Semester updated successfully' });
    } catch (err) {
      return next(err);
    }
  },
);

// Delete a semester (CUSTODIAN cannot delete)
router.delete(
  '/:semesterId',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const semesterId = Number(req.params.semesterId);
      const db = getDb();

      // Verify semester exists and get hostel_id
      const [semesterRows] = await db.execute(
        'SELECT id, hostel_id, is_active FROM semesters WHERE id = ? LIMIT 1',
        [semesterId]
      );

      if (semesterRows.length === 0) {
        return res.status(404).json({ error: 'Semester not found' });
      }

      const semester = semesterRows[0];
      const effectiveHostelId = semester.hostel_id;

      // Check authorization
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(effectiveHostelId) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Semester does not belong to your hostel' });
        }
      }

      // Prevent deleting active semester
      if (semester.is_active === 1) {
        return res.status(400).json({ 
          error: 'Cannot delete an active semester. Please deactivate it first.' 
        });
      }

      // Check if semester has associated students
      const [studentCount] = await db.execute(
        'SELECT COUNT(*) as count FROM students WHERE semester_id = ?',
        [semesterId]
      );

      if (studentCount[0].count > 0) {
        return res.status(400).json({ 
          error: `Cannot delete semester. It has ${studentCount[0].count} associated student(s). Please remove students first or deactivate the semester instead.` 
        });
      }

      // Delete the semester
      await db.execute('DELETE FROM semesters WHERE id = ?', [semesterId]);

      await writeAuditLog(db, req, {
        action: 'SEMESTER_DELETED',
        entityType: 'semester',
        entityId: semesterId,
        details: { hostelId: effectiveHostelId },
      });

      return res.json({ message: 'Semester deleted successfully' });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
