const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

const expenseSchema = Joi.object({
  amount: Joi.number().precision(2).min(0.01).required(),
  description: Joi.string().max(500).required(),
  category: Joi.string().max(100).allow(null, ''),
  expenseDate: Joi.date().required(),
  semesterId: Joi.number().integer().allow(null),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
});

// Custodian: record expense
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = expenseSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { amount, description, category, expenseDate, semesterId, hostelId } = value;
      const db = getDb();

      // Determine hostel scope
      let effectiveHostelId = null;
      if (req.user.role === 'SUPER_ADMIN') {
        if (!hostelId) return res.status(400).json({ error: 'hostelId is required' });
        effectiveHostelId = hostelId;
      } else {
        if (!req.user.hostelId) return res.status(400).json({ error: 'User is not linked to a hostel' });
        effectiveHostelId = req.user.hostelId;
      }

      // Get active semester if not provided - expenses must be tied to a semester
      let effectiveSemesterId = semesterId;
      if (!effectiveSemesterId) {
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [effectiveHostelId]
        );
        if (semRows.length === 0) {
          return res.status(400).json({ error: 'No active semester found. Please activate a semester before recording expenses.' });
        }
        effectiveSemesterId = semRows[0].id;
      } else {
        // Verify the semester belongs to this hostel
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE id = ? AND hostel_id = ? LIMIT 1',
          [effectiveSemesterId, effectiveHostelId]
        );
        if (semRows.length === 0) {
          return res.status(400).json({ error: 'Invalid semester or semester does not belong to this hostel' });
        }
      }

      // Insert expense
      const [result] = await db.execute(
        'INSERT INTO expenses (hostel_id, semester_id, amount, description, category, recorded_by_user_id, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [effectiveHostelId, effectiveSemesterId, amount, description, category || null, req.user.sub, expenseDate]
      );

      await writeAuditLog(db, req, {
        action: 'EXPENSE_RECORDED',
        entityType: 'expense',
        entityId: result.insertId,
        details: { hostelId: effectiveHostelId, amount, description, category },
      });

      return res.status(201).json({
        message: 'Expense recorded successfully',
        expenseId: result.insertId,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// Hostel Owner / Custodian: get expenses
router.get(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let expenses;

      // Get active semester ID for filtering
      let activeSemesterId = null;
      let effectiveHostelId = null;

      if (req.user.role === 'SUPER_ADMIN') {
        effectiveHostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (effectiveHostelId) {
          const [semRows] = await db.execute(
            'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
            [effectiveHostelId]
          );
          activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
        }
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [effectiveHostelId]
        );
        activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
      }

      // Get pagination parameters first
      const limit = req.query.limit ? Number(req.query.limit) : 1000;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      // Filter by semester if provided or use active semester - expenses must be tied to a semester
      const semesterFilter = req.query.semesterId ? Number(req.query.semesterId) : activeSemesterId;
      if (!semesterFilter) {
        // If no active semester, return empty array (expenses require a semester)
        return res.json({
          expenses: [],
          total: 0,
          limit: limit,
          offset: offset,
        });
      }

      // Build query based on role and filters
      let query = `
        SELECT e.id, e.hostel_id, e.semester_id, e.amount, e.description, e.category,
               e.expense_date, e.created_at,
               e.recorded_by_user_id,
               u.username AS recorded_by_username,
               u.phone AS recorded_by_phone
        FROM expenses e
        LEFT JOIN users u ON e.recorded_by_user_id = u.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role === 'SUPER_ADMIN') {
        if (effectiveHostelId) {
          query += ' AND e.hostel_id = ?';
          params.push(effectiveHostelId);
        }
      } else {
        query += ' AND e.hostel_id = ?';
        params.push(effectiveHostelId);
      }

      query += ' AND e.semester_id = ?';
      params.push(semesterFilter);

      // Filter by date range if provided
      if (req.query.startDate) {
        query += ' AND e.expense_date >= ?';
        params.push(req.query.startDate);
      }
      if (req.query.endDate) {
        query += ' AND e.expense_date <= ?';
        params.push(req.query.endDate);
      }

      // Filter by category if provided
      if (req.query.category) {
        query += ' AND e.category = ?';
        params.push(req.query.category);
      }

      query += ' ORDER BY e.expense_date DESC, e.created_at DESC';

      // Add limit and offset for pagination - use template literals since these are safe values we control
      const limitInt = parseInt(limit, 10);
      const offsetInt = parseInt(offset, 10);
      query += ` LIMIT ${limitInt} OFFSET ${offsetInt}`;

      [expenses] = await db.execute(query, params);

      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) AS total FROM expenses WHERE 1=1';
      const countParams = [];
      if (req.user.role !== 'SUPER_ADMIN' || effectiveHostelId) {
        countQuery += ' AND hostel_id = ?';
        countParams.push(effectiveHostelId);
      }
      // semesterFilter is guaranteed to exist at this point
      countQuery += ' AND semester_id = ?';
      countParams.push(semesterFilter);
      if (req.query.startDate) {
        countQuery += ' AND expense_date >= ?';
        countParams.push(req.query.startDate);
      }
      if (req.query.endDate) {
        countQuery += ' AND expense_date <= ?';
        countParams.push(req.query.endDate);
      }
      if (req.query.category) {
        countQuery += ' AND category = ?';
        countParams.push(req.query.category);
      }

      const [countRows] = await db.execute(countQuery, countParams);
      const total = countRows[0].total;

      return res.json({
        expenses,
        total,
        limit,
        offset,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// Get expense statistics (total, by category, etc.)
router.get(
  '/stats',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let effectiveHostelId = null;
      let activeSemesterId = null;

      if (req.user.role === 'SUPER_ADMIN') {
        effectiveHostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (effectiveHostelId) {
          const [semRows] = await db.execute(
            'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
            [effectiveHostelId]
          );
          activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
        }
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [effectiveHostelId]
        );
        activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
      }

      // Expenses must be tied to a semester
      const semesterFilter = req.query.semesterId ? Number(req.query.semesterId) : activeSemesterId;
      if (!semesterFilter) {
        // If no active semester, return empty stats
        return res.json({
          total: 0,
          byCategory: [],
        });
      }

      let query = 'SELECT SUM(amount) AS total FROM expenses WHERE hostel_id = ? AND semester_id = ?';
      const params = [effectiveHostelId, semesterFilter];

      if (req.query.startDate) {
        query += ' AND expense_date >= ?';
        params.push(req.query.startDate);
      }
      if (req.query.endDate) {
        query += ' AND expense_date <= ?';
        params.push(req.query.endDate);
      }

      const [totalRows] = await db.execute(query, params);
      const total = Number(totalRows[0].total || 0);

      // Get expenses by category
      let categoryQuery = `
        SELECT category, SUM(amount) AS total
        FROM expenses
        WHERE hostel_id = ? AND semester_id = ?
      `;
      const categoryParams = [effectiveHostelId, semesterFilter];
      if (req.query.startDate) {
        categoryQuery += ' AND expense_date >= ?';
        categoryParams.push(req.query.startDate);
      }
      if (req.query.endDate) {
        categoryQuery += ' AND expense_date <= ?';
        categoryParams.push(req.query.endDate);
      }

      categoryQuery += ' GROUP BY category ORDER BY total DESC';

      const [categoryRows] = await db.execute(categoryQuery, categoryParams);

      return res.json({
        total,
        byCategory: categoryRows,
      });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
