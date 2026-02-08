const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');
const { canOwnerViewPaymentAmounts } = require('../utils/feature-settings.util');

const router = express.Router();

const studentSchema = Joi.object({
  fullName: Joi.string().max(150).required(),
  registrationNumber: Joi.string().max(50).required(),
  phone: Joi.string().max(20).allow(null, ''),
  email: Joi.string().email().max(100).allow(null, ''),
  accessNumber: Joi.string().max(50).allow(null, ''),
  address: Joi.string().max(255).allow(null, ''),
  emergencyContact: Joi.string().max(100).allow(null, ''),
  gender: Joi.string().valid('male', 'female').required(),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
});

// Custodian / Hostel Owner: register students
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = studentSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { fullName, registrationNumber, phone, email, accessNumber, address, emergencyContact, gender, hostelId } = value;
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

      // Get active semester for this hostel
      const [activeSemesterRows] = await db.execute(
        'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
        [effectiveHostelId]
      );

      if (activeSemesterRows.length === 0) {
        return res.status(400).json({ error: 'No active semester found. Please create and activate a semester first.' });
      }

      const activeSemesterId = activeSemesterRows[0].id;

      // Check if this registration number already exists in this semester
      const [existingStudent] = await db.execute(
        'SELECT id FROM students WHERE registration_number = ? AND semester_id = ? LIMIT 1',
        [registrationNumber, activeSemesterId]
      );

      if (existingStudent.length > 0) {
        return res.status(409).json({ 
          error: `Registration number "${registrationNumber}" already exists for this semester. A student can register for multiple semesters, but each registration number must be unique within a semester.` 
        });
      }

      await db.execute(
        'INSERT INTO students (hostel_id, semester_id, full_name, registration_number, phone, email, access_number, address, emergency_contact, gender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [effectiveHostelId, activeSemesterId, fullName, registrationNumber, phone || null, email || null, accessNumber || null, address || null, emergencyContact || null, gender],
      );

      await writeAuditLog(db, req, {
        action: 'STUDENT_REGISTERED',
        entityType: 'student',
        details: { hostelId: effectiveHostelId, fullName, registrationNumber, semesterId: activeSemesterId },
      });

      return res.status(201).json({ message: 'Student registered' });
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        // Fallback: if the composite unique constraint is triggered
        if (err.message && err.message.includes('idx_students_reg_semester')) {
          return res.status(409).json({ 
            error: `Registration number "${registrationNumber}" already exists for this semester. A student can register for multiple semesters, but each registration number must be unique within a semester.` 
          });
        }
        // Legacy error for old unique constraint (shouldn't happen after migration)
        return res.status(409).json({ 
          error: `Registration number "${registrationNumber}" already exists. If you're trying to register for a new semester, please ensure the database migration has run to allow multi-semester registration.` 
        });
      }
      return next(err);
    }
  },
);

router.get(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let rows;
      // Get active semester ID for filtering
      let activeSemesterId = null;
      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          const [semRows] = await db.execute(
            'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
            [hostelId]
          );
          activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
        }
      } else if (req.user.hostelId) {
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [req.user.hostelId]
        );
        activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
      }

      if (req.user.role === 'SUPER_ADMIN') {
        if (activeSemesterId) {
          [rows] = await db.execute(
            'SELECT id, hostel_id, semester_id, full_name, registration_number, phone, email, access_number, address, emergency_contact, gender FROM students WHERE semester_id = ? ORDER BY id DESC',
            [activeSemesterId],
          );
        } else {
          [rows] = await db.execute(
            'SELECT id, hostel_id, semester_id, full_name, registration_number, phone, email, access_number, address, emergency_contact, gender FROM students ORDER BY id DESC',
          );
        }
      } else if (req.user.hostelId) {
        if (activeSemesterId) {
          [rows] = await db.execute(
            'SELECT id, hostel_id, semester_id, full_name, registration_number, phone, email, access_number, address, emergency_contact, gender FROM students WHERE hostel_id = ? AND semester_id = ? ORDER BY id DESC',
            [req.user.hostelId, activeSemesterId],
          );
        } else {
          rows = []; // No active semester, return empty
        }
      } else {
        rows = [];
      }
      return res.json(rows);
    } catch (err) {
      return next(err);
    }
  },
);

// Hostel Owner: get students with details (allocations, rooms, payments)
// Accessible via /api/owner/students/details
router.get(
  '/students/details',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      let students;
      
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

      if (req.user.role === 'SUPER_ADMIN') {
        // Super Admin can see all students, but needs hostelId in query
        if (effectiveHostelId) {
          if (activeSemesterId) {
            [students] = await db.execute(
              `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.registration_number, s.phone, s.email, 
                      s.access_number, s.address, s.emergency_contact, s.gender
               FROM students s
               WHERE s.hostel_id = ? AND s.semester_id = ?
               ORDER BY s.id DESC`,
              [effectiveHostelId, activeSemesterId]
            );
          } else {
            students = []; // No active semester
          }
        } else {
          // No hostel filter - return all (for super admin overview)
          [students] = await db.execute(
            `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.registration_number, s.phone, s.email,
                    s.access_number, s.address, s.emergency_contact, s.gender
             FROM students s
             ORDER BY s.id DESC`
          );
        }
      } else {
        // CUSTODIAN and HOSTEL_OWNER can only see their hostel's students
        if (activeSemesterId) {
          [students] = await db.execute(
            `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.registration_number, s.phone, s.email,
                    s.access_number, s.address, s.emergency_contact, s.gender
             FROM students s
             WHERE s.hostel_id = ? AND s.semester_id = ?
             ORDER BY s.id DESC`,
            [effectiveHostelId, activeSemesterId]
          );
        } else {
          students = []; // No active semester
        }
      }

      // Get allocations (filtered by active semester)
      let allocations;
      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          if (activeSemesterId) {
            [allocations] = await db.execute(
              `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation,
                      a.allocated_at
               FROM allocations a
               WHERE a.hostel_id = ? AND a.semester_id = ?`,
              [hostelId, activeSemesterId]
            );
          } else {
            allocations = [];
          }
        } else {
          if (activeSemesterId) {
            [allocations] = await db.execute(
              `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation,
                      a.allocated_at
               FROM allocations a
               WHERE a.semester_id = ?`,
              [activeSemesterId]
            );
          } else {
            allocations = [];
          }
        }
      } else {
        if (activeSemesterId) {
          [allocations] = await db.execute(
            `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation,
                    a.allocated_at
             FROM allocations a
             WHERE a.hostel_id = ? AND a.semester_id = ?`,
            [effectiveHostelId, activeSemesterId]
          );
        } else {
          allocations = [];
        }
      }

      // Get rooms
      let rooms;
      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          [rooms] = await db.execute(
            'SELECT id, name, price, capacity, hostel_id FROM rooms WHERE hostel_id = ?',
            [hostelId]
          );
        } else {
          [rooms] = await db.execute('SELECT id, name, price, capacity, hostel_id FROM rooms');
        }
      } else {
        [rooms] = await db.execute(
          'SELECT id, name, price, capacity, hostel_id FROM rooms WHERE hostel_id = ?',
          [req.user.hostelId]
        );
      }

      // Get payments (filtered by active semester through allocations)
      let payments;
      if (req.user.role === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          if (activeSemesterId) {
            [payments] = await db.execute(
              `SELECT p.id, p.allocation_id, p.semester_id, p.amount
               FROM payments p
               JOIN allocations a ON p.allocation_id = a.id
               WHERE a.hostel_id = ? AND a.semester_id = ?`,
              [hostelId, activeSemesterId]
            );
          } else {
            payments = [];
          }
        } else {
          if (activeSemesterId) {
            [payments] = await db.execute(
              `SELECT p.id, p.allocation_id, p.semester_id, p.amount
               FROM payments p
               JOIN allocations a ON p.allocation_id = a.id
               WHERE a.semester_id = ?`,
              [activeSemesterId]
            );
          } else {
            payments = [];
          }
        }
      } else {
        if (activeSemesterId) {
          [payments] = await db.execute(
            `SELECT p.id, p.allocation_id, p.semester_id, p.amount
             FROM payments p
             JOIN allocations a ON p.allocation_id = a.id
             WHERE a.hostel_id = ? AND a.semester_id = ?`,
            [effectiveHostelId, activeSemesterId]
          );
        } else {
          payments = [];
        }
      }

      // Check if Hostel Owner can view payment amounts
      let canViewPayments = true;
      if (req.user.role === 'HOSTEL_OWNER' && effectiveHostelId) {
        canViewPayments = await canOwnerViewPaymentAmounts(effectiveHostelId);
      }
      // Super Admin and Custodians always can view payments
      if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'CUSTODIAN') {
        canViewPayments = true;
      }

      // Combine data
      const result = students.map((student) => {
        const allocation = allocations.find((a) => a.student_id === student.id);
        const room = allocation ? rooms.find((r) => r.id === allocation.room_id) : null;
        
        // Calculate payment summary
        let totalPaid = 0;
        let totalRequired = 0;
        if (allocation) {
          totalRequired = Number(allocation.room_price_at_allocation || 0);
          const allocationPayments = payments.filter((p) => p.allocation_id === allocation.id);
          totalPaid = allocationPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
        }

        const studentData = {
          id: student.id,
          hostel_id: student.hostel_id,
          full_name: student.full_name,
          registration_number: student.registration_number,
          phone: student.phone,
          email: student.email,
          access_number: student.access_number,
          address: student.address,
          emergency_contact: student.emergency_contact,
          gender: student.gender,
          room: room ? { id: room.id, name: room.name } : null,
          allocation: allocation ? {
            id: allocation.id,
            room_price_at_allocation: allocation.room_price_at_allocation,
            allocated_at: allocation.allocated_at,
          } : null,
        };

        // Only include payment summary if user can view payments
        if (canViewPayments) {
          studentData.paymentSummary = {
            totalPaid,
            totalRequired,
            balance: totalRequired - totalPaid,
          };
        } else {
          // Hide payment information for Hostel Owners when setting is disabled
          studentData.paymentSummary = null;
        }

        return studentData;
      });

      return res.json(result);
    } catch (err) {
      return next(err);
    }
  },
);

// Get SMS history for a student
router.get(
  '/:studentId/sms-history',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const studentId = Number(req.params.studentId);
      if (!studentId || isNaN(studentId)) {
        return res.status(400).json({ error: 'Invalid student ID' });
      }

      const db = getDb();
      let effectiveHostelId = null;

      if (req.user.role === 'SUPER_ADMIN') {
        // Super Admin can view any student's SMS history
        effectiveHostelId = null;
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
      }

      // Verify student exists and belongs to the hostel (if not super admin)
      const [studentRows] = await db.execute(
        'SELECT id, hostel_id FROM students WHERE id = ? LIMIT 1',
        [studentId]
      );

      if (!studentRows.length) {
        return res.status(404).json({ error: 'Student not found' });
      }

      if (effectiveHostelId !== null && Number(studentRows[0].hostel_id) !== Number(effectiveHostelId)) {
        return res.status(403).json({ error: 'Student does not belong to your hostel' });
      }

      // Get SMS history for this student
      const [smsHistory] = await db.execute(
        `SELECT 
          id,
          student_id,
          phone,
          message_type,
          message_content,
          message_status,
          error_message,
          sent_at,
          sent_by_user_id,
          u.username AS sent_by_username
         FROM sms_history sh
         LEFT JOIN users u ON sh.sent_by_user_id = u.id
         WHERE sh.student_id = ?
         ORDER BY sh.sent_at DESC
         LIMIT 50`,
        [studentId]
      );

      return res.json(smsHistory);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;

