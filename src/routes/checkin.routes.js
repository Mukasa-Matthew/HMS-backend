const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');
const { createCheckInMessage, createCheckOutMessage, sendSMSWithHistory } = require('../utils/sms.util');

const router = express.Router();

const checkInSchema = Joi.object({
  studentId: Joi.number().integer().required(),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
});

const checkOutSchema = Joi.object({
  studentId: Joi.number().integer().required(),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
});

// Get all checked-in students for the current hostel/semester
router.get(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let effectiveHostelId = null;

      if (req.user.role === 'SUPER_ADMIN') {
        // Super Admin can query any hostel
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (!hostelId) {
          return res.status(400).json({ error: 'hostelId is required for Super Admin' });
        }
        effectiveHostelId = hostelId;
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
      }

      // Get active semester for this hostel
      const [activeSemesterRows] = await db.execute(
        'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
        [effectiveHostelId]
      );

      if (activeSemesterRows.length === 0) {
        return res.json([]); // No active semester, return empty array
      }

      const activeSemesterId = activeSemesterRows[0].id;

      // Get all check-ins for this hostel and semester that haven't been checked out
      const [checkIns] = await db.execute(
        `SELECT 
          ci.id,
          ci.student_id,
          ci.hostel_id,
          ci.semester_id,
          ci.checked_in_at,
          ci.checked_out_at,
          ci.checked_in_by_user_id,
          ci.checked_out_by_user_id,
          s.full_name,
          s.registration_number
        FROM check_ins ci
        JOIN students s ON ci.student_id = s.id
        WHERE ci.hostel_id = ? AND ci.semester_id = ?
        ORDER BY ci.checked_in_at DESC`,
        [effectiveHostelId, activeSemesterId]
      );

      return res.json(checkIns);
    } catch (err) {
      return next(err);
    }
  }
);

// Check in a student
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = checkInSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { studentId, hostelId } = value;
      const db = getDb();

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

      // Verify student exists and belongs to this hostel, get student and hostel details
      const [studentRows] = await db.execute(
        `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.phone, h.name AS hostel_name
         FROM students s
         LEFT JOIN hostels h ON s.hostel_id = h.id
         WHERE s.id = ? LIMIT 1`,
        [studentId]
      );

      if (!studentRows.length) {
        return res.status(404).json({ error: 'Student not found' });
      }

      const student = studentRows[0];
      if (Number(student.hostel_id) !== Number(effectiveHostelId)) {
        return res.status(403).json({ error: 'Student does not belong to your hostel' });
      }

      if (!student.semester_id) {
        return res.status(400).json({ error: 'Student is not registered for a semester' });
      }

      // Check if student is already checked in (not checked out)
      const [existingCheckIn] = await db.execute(
        'SELECT id, checked_out_at FROM check_ins WHERE student_id = ? AND semester_id = ? AND checked_out_at IS NULL LIMIT 1',
        [studentId, student.semester_id]
      );

      if (existingCheckIn.length > 0) {
        return res.status(409).json({ error: 'Student is already checked in' });
      }

      // Create check-in record
      const [result] = await db.execute(
        'INSERT INTO check_ins (student_id, hostel_id, semester_id, checked_in_by_user_id) VALUES (?, ?, ?, ?)',
        [studentId, effectiveHostelId, student.semester_id, req.user.sub]
      );

      await writeAuditLog(db, req, {
        action: 'STUDENT_CHECKED_IN',
        entityType: 'check_in',
        entityId: result.insertId,
        details: { hostelId: effectiveHostelId, studentId, semesterId: student.semester_id },
      });

      // Send welcome SMS to student if phone number exists
      let smsResult = null;
      if (student.phone) {
        try {
          const hostelName = student.hostel_name || 'Hostel';
          const studentName = student.full_name || 'Student';

          const message = createCheckInMessage(hostelName, studentName);

          smsResult = await sendSMSWithHistory({
            studentId: studentId,
            phone: student.phone,
            messageType: 'CHECK_IN',
            message: message,
            sentByUserId: req.user.sub,
          });
        } catch (smsError) {
          // Log error but don't fail the check-in
          console.error('Failed to send check-in SMS:', smsError);
        }
      }

      return res.status(201).json({ 
        message: 'Student checked in successfully',
        checkInId: result.insertId,
        smsSent: smsResult?.success || false,
        smsHistoryId: smsResult?.smsHistoryId || null,
      });
    } catch (err) {
      return next(err);
    }
  }
);

// Check out a student
router.post(
  '/checkout',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = checkOutSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { studentId, hostelId } = value;
      const db = getDb();

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

      // Verify student exists and belongs to this hostel, get student and hostel details
      const [studentRows] = await db.execute(
        `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.phone, h.name AS hostel_name
         FROM students s
         LEFT JOIN hostels h ON s.hostel_id = h.id
         WHERE s.id = ? LIMIT 1`,
        [studentId]
      );

      if (!studentRows.length) {
        return res.status(404).json({ error: 'Student not found' });
      }

      const student = studentRows[0];
      if (Number(student.hostel_id) !== Number(effectiveHostelId)) {
        return res.status(403).json({ error: 'Student does not belong to your hostel' });
      }

      if (!student.semester_id) {
        return res.status(400).json({ error: 'Student is not registered for a semester' });
      }

      // Find the active check-in (not checked out)
      const [checkInRows] = await db.execute(
        'SELECT id FROM check_ins WHERE student_id = ? AND semester_id = ? AND checked_out_at IS NULL LIMIT 1',
        [studentId, student.semester_id]
      );

      if (!checkInRows.length) {
        return res.status(404).json({ error: 'Student is not currently checked in' });
      }

      const checkInId = checkInRows[0].id;

      // Update check-in record with check-out timestamp
      await db.execute(
        'UPDATE check_ins SET checked_out_at = NOW(), checked_out_by_user_id = ? WHERE id = ?',
        [req.user.sub, checkInId]
      );

      await writeAuditLog(db, req, {
        action: 'STUDENT_CHECKED_OUT',
        entityType: 'check_in',
        entityId: checkInId,
        details: { hostelId: effectiveHostelId, studentId, semesterId: student.semester_id },
      });

      // Send check-out SMS to student if phone number exists
      let smsResult = null;
      if (student.phone) {
        try {
          const hostelName = student.hostel_name || 'Hostel';
          const studentName = student.full_name || 'Student';

          const message = createCheckOutMessage(hostelName, studentName);

          smsResult = await sendSMSWithHistory({
            studentId: studentId,
            phone: student.phone,
            messageType: 'CHECK_OUT',
            message: message,
            sentByUserId: req.user.sub,
          });
        } catch (smsError) {
          // Log error but don't fail the check-out
          console.error('Failed to send check-out SMS:', smsError);
        }
      }

      return res.json({ 
        message: 'Student checked out successfully',
        smsSent: smsResult?.success || false,
        smsHistoryId: smsResult?.smsHistoryId || null,
      });
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
