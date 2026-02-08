const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');
const { createRegistrationEmailHTML, sendEmailWithHistory } = require('../utils/email.util');
const { createRegistrationMessage, sendSMSWithHistory } = require('../utils/sms.util');
const { isCustodianPriceMarkupEnabled } = require('../utils/feature-settings.util');
const { getReceiptData, createReceiptHTML, createSMSReceipt } = require('../utils/receipt.util');

const router = express.Router();

const allocationSchema = Joi.object({
  studentId: Joi.number().integer().required(),
  roomId: Joi.number().integer().required(),
  hostelId: Joi.number().integer().optional(), // SUPER_ADMIN can supply
  displayPrice: Joi.number().precision(2).min(0.01).optional(), // Display price shown to student (only when feature enabled)
});

const paymentSchema = Joi.object({
  allocationId: Joi.number().integer().required(),
  amount: Joi.number().precision(2).min(0.01).required(),
});

// Custodian / Hostel Owner: assign room (creates allocation with fixed room price at assignment time)
router.post(
  '/allocate',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = allocationSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }
      const { studentId, roomId, hostelId, displayPrice } = value;
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

      // Ensure room belongs to this hostel and fetch price and capacity
      const [roomRows] = await db.execute(
        'SELECT id, price, capacity, hostel_id FROM rooms WHERE id = ? AND is_active = 1 LIMIT 1',
        [roomId],
      );
      if (!roomRows.length) {
        return res.status(404).json({ error: 'Room not found or inactive' });
      }

      const room = roomRows[0];
      if (Number(room.hostel_id) !== Number(effectiveHostelId)) {
        return res.status(403).json({ error: 'Room does not belong to your hostel' });
      }

      // Ensure student belongs to this hostel and get student details
      const [studentRows] = await db.execute(
        `SELECT s.id, s.hostel_id, s.semester_id, s.full_name, s.phone, s.email, h.name AS hostel_name, r.name AS room_name
         FROM students s
         LEFT JOIN hostels h ON s.hostel_id = h.id
         LEFT JOIN rooms r ON r.id = ?
         WHERE s.id = ? LIMIT 1`,
        [roomId, studentId],
      );
      if (!studentRows.length) {
        return res.status(404).json({ error: 'Student not found' });
      }
      if (Number(studentRows[0].hostel_id) !== Number(effectiveHostelId)) {
        return res.status(403).json({ error: 'Student does not belong to your hostel' });
      }

      const student = studentRows[0];
      const studentSemesterId = student.semester_id;
      if (!studentSemesterId) {
        return res.status(400).json({ error: 'Student is not registered for a semester' });
      }

      // IDEMPOTENCY: Check if student already has an allocation for this semester
      const [existingAllocation] = await db.execute(
        'SELECT id, room_id FROM allocations WHERE student_id = ? AND semester_id = ? LIMIT 1',
        [studentId, studentSemesterId]
      );

      if (existingAllocation.length > 0) {
        const existingRoomId = existingAllocation[0].room_id;
        if (Number(existingRoomId) === Number(roomId)) {
          return res.status(409).json({ 
            error: 'Student is already allocated to this room for this semester. This operation is idempotent.' 
          });
        } else {
          return res.status(409).json({ 
            error: `Student already has an allocation for this semester (room ID: ${existingRoomId}). Please remove the existing allocation first if you want to change rooms.` 
          });
        }
      }

      // Check room capacity - count current active allocations for this room in the current semester
      // Only count allocations where students haven't checked out
      const [activeAllocations] = await db.execute(
        `SELECT COUNT(DISTINCT a.id) AS occupied
         FROM allocations a
         WHERE a.room_id = ? 
           AND a.semester_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM check_ins ci 
             WHERE ci.student_id = a.student_id 
               AND ci.semester_id = a.semester_id 
               AND ci.checked_out_at IS NOT NULL
           )`,
        [roomId, studentSemesterId]
      );

      const currentOccupancy = activeAllocations[0]?.occupied || 0;
      const roomCapacity = Number(room.capacity) || 1;

      if (currentOccupancy >= roomCapacity) {
        return res.status(400).json({ 
          error: `Room is at full capacity (${currentOccupancy}/${roomCapacity}). Cannot allocate more students.` 
        });
      }

      // Calculate price per student based on room capacity (FIXED, regardless of occupancy)
      // Logic:
      // - If room capacity = 1: student pays full room price
      // - If room capacity > 1: each student ALWAYS pays (room price / capacity)
      //   This is fixed - each student pays their independent share regardless of how many are in the room
      // Example: Room = 600,000, Capacity = 2
      //   - Student A pays 300,000 (their fixed share)
      //   - Student B pays 300,000 (their fixed share)
      //   - If only Student A is in room, they still pay 300,000 (not 600,000)
      //   - Each student's payment is independent - Student A's balance doesn't affect Student B
      const roomPrice = Number(room.price) || 0;
      
      let pricePerStudent;
      if (roomCapacity === 1) {
        // Single occupancy room: student pays full price
        pricePerStudent = roomPrice;
      } else {
        // Multi-occupancy room: divide price by capacity (FIXED for all students)
        // Each student pays their independent share (e.g., 600,000 / 2 = 300,000 per student)
        // This price is fixed regardless of actual occupancy
        pricePerStudent = roomPrice / roomCapacity;
      }

      // Check if custodian price markup feature is enabled
      const markupEnabled = await isCustodianPriceMarkupEnabled(effectiveHostelId);
      let displayPricePerStudent = null;

      // Validate displayPrice if provided
      if (displayPrice !== undefined) {
        if (!markupEnabled) {
          return res.status(400).json({ 
            error: 'Display price is only allowed when custodian price markup feature is enabled for this hostel' 
          });
        }
        
        // Only CUSTODIAN role can set display prices
        if (req.user.role !== 'CUSTODIAN') {
          return res.status(403).json({ 
            error: 'Only custodians can set display prices when the feature is enabled' 
          });
        }

        // Calculate display price per student (same logic as actual price)
        if (roomCapacity === 1) {
          displayPricePerStudent = Number(displayPrice);
        } else {
          displayPricePerStudent = Number(displayPrice) / roomCapacity;
        }

        // Validate display price is not less than actual price
        if (displayPricePerStudent < pricePerStudent) {
          return res.status(400).json({ 
            error: 'Display price cannot be less than the actual room price' 
          });
        }
      }

      // Create allocation with snapshot of price per student (fixed based on capacity)
      // This price never changes - each student pays their own independent share
      const [result] = await db.execute(
        'INSERT INTO allocations (hostel_id, semester_id, student_id, room_id, room_price_at_allocation, display_price_at_allocation) VALUES (?, ?, ?, ?, ?, ?)',
        [effectiveHostelId, studentSemesterId, studentId, room.id, pricePerStudent, displayPricePerStudent],
      );

      await writeAuditLog(db, req, {
        action: 'ROOM_ALLOCATED',
        entityType: 'allocation',
        entityId: result.insertId,
        details: { hostelId: effectiveHostelId, studentId, roomId },
      });

      // Send notification: Email first, SMS fallback if no email
      let emailResult = null;
      let smsResult = null;
      const hostelName = student.hostel_name || 'Hostel';
      const studentName = student.full_name || 'Student';
      const roomNumber = student.room_name || room.id.toString();
      const amountPaid = 0; // No payment yet
      // Use display price for student notifications if available, otherwise use actual price
      const amountLeft = displayPricePerStudent || pricePerStudent;

      // Try email first if student has email
      if (student.email) {
        try {
          const html = createRegistrationEmailHTML(
            hostelName,
            studentName,
            roomNumber,
            amountPaid,
            amountLeft
          );

          emailResult = await sendEmailWithHistory({
            studentId: studentId,
            email: student.email,
            messageType: 'REGISTRATION',
            subject: `Welcome to ${hostelName} - Room Allocation`,
            html: html,
            sentByUserId: req.user.sub,
          });
        } catch (emailError) {
          // Log error but don't fail the allocation
          console.error('Failed to send registration email:', emailError);
          // Fallback to SMS if email fails and phone exists
          if (student.phone) {
            try {
              const message = createRegistrationMessage(
                hostelName,
                studentName,
                roomNumber,
                amountPaid,
                amountLeft
              );
              smsResult = await sendSMSWithHistory({
                studentId: studentId,
                phone: student.phone,
                messageType: 'REGISTRATION',
                message: message,
                sentByUserId: req.user.sub,
              });
            } catch (smsError) {
              console.error('Failed to send registration SMS fallback:', smsError);
            }
          }
        }
      } else if (student.phone) {
        // No email, try SMS
        try {
          const message = createRegistrationMessage(
            hostelName,
            studentName,
            roomNumber,
            amountPaid,
            amountLeft
          );
          smsResult = await sendSMSWithHistory({
            studentId: studentId,
            phone: student.phone,
            messageType: 'REGISTRATION',
            message: message,
            sentByUserId: req.user.sub,
          });
        } catch (smsError) {
          console.error('Failed to send registration SMS:', smsError);
        }
      }

      return res.status(201).json({
        message: 'Room allocated',
        allocationId: result.insertId,
        totalRequired: pricePerStudent,
        roomCapacity: roomCapacity,
        pricePerStudent: pricePerStudent,
        emailSent: emailResult?.success || false,
        emailHistoryId: emailResult?.emailHistoryId || null,
        smsSent: smsResult?.success || false,
        smsHistoryId: smsResult?.smsHistoryId || null,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// Custodian / Hostel Owner: record payment (partial or full)
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const { error, value } = paymentSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }
      const { allocationId, amount } = value;
      const db = getDb();

      // Ensure allocation exists
      const [allocRows] = await db.execute(
        'SELECT id, hostel_id, semester_id, room_price_at_allocation, display_price_at_allocation FROM allocations WHERE id = ? LIMIT 1',
        [allocationId],
      );
      if (!allocRows.length) {
        return res.status(404).json({ error: 'Allocation not found' });
      }
      const allocation = allocRows[0];
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) return res.status(400).json({ error: 'User is not linked to a hostel' });
        if (Number(allocation.hostel_id) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Allocation does not belong to your hostel' });
        }
      }

      // Check if markup is enabled for this hostel
      const markupEnabled = await isCustodianPriceMarkupEnabled(allocation.hostel_id);
      const actualPrice = Number(allocation.room_price_at_allocation || 0);
      const displayPrice = allocation.display_price_at_allocation ? Number(allocation.display_price_at_allocation) : null;
      const markupRatio = displayPrice && markupEnabled ? displayPrice / actualPrice : 1;

      // Check current balance before recording payment (using actual amounts)
      const [currentTotalRows] = await db.execute(
        'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE allocation_id = ?',
        [allocationId],
      );
      const currentTotalPaid = Number(currentTotalRows[0].total_paid || 0);
      const totalRequired = actualPrice; // Always use actual price for validation
      const currentBalance = totalRequired - currentTotalPaid;

      // Prevent overpayment - check if payment would exceed the balance
      if (currentBalance <= 0) {
        return res.status(400).json({ 
          error: 'This student has already completed their payment. No additional payments can be recorded.' 
        });
      }

      if (amount > currentBalance) {
        return res.status(400).json({ 
          error: `Payment amount (${amount.toLocaleString()}) exceeds the outstanding balance (${currentBalance.toLocaleString()}). Maximum allowed: ${currentBalance.toLocaleString()}` 
        });
      }

      // IDEMPOTENCY: Check for duplicate payment within last 5 seconds (same amount, same allocation, same user)
      // This prevents accidental double-submission from frontend
      const [recentPayment] = await db.execute(
        `SELECT id FROM payments 
         WHERE allocation_id = ? 
           AND amount = ? 
           AND recorded_by_user_id = ?
           AND recorded_at >= DATE_SUB(NOW(), INTERVAL 5 SECOND)
         LIMIT 1`,
        [allocationId, amount, req.user.sub]
      );

      if (recentPayment.length > 0) {
        return res.status(409).json({ 
          error: 'A payment with the same amount was recorded very recently. This may be a duplicate request. Please refresh and check if the payment was already recorded.',
          paymentId: recentPayment[0].id
        });
      }

      // Insert payment (recorded after money is received externally)
      const [paymentResult] = await db.execute(
        'INSERT INTO payments (allocation_id, semester_id, amount, recorded_by_user_id) VALUES (?, ?, ?, ?)',
        [allocationId, allocation.semester_id, amount, req.user.sub],
      );
      const paymentId = paymentResult.insertId;

      await writeAuditLog(db, req, {
        action: 'PAYMENT_RECORDED',
        entityType: 'payment',
        details: { allocationId, amount },
      });

      // Recalculate total paid and balance (after payment is recorded)
      const [totalRows] = await db.execute(
        'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE allocation_id = ?',
        [allocationId],
      );
      const totalPaid = Number(totalRows[0].total_paid || 0);
      const balance = totalRequired - totalPaid;
      
      // Calculate display amounts for student notifications
      const displayTotalPaid = totalPaid * markupRatio;
      const displayTotalRequired = displayPrice || actualPrice;
      const displayBalance = displayTotalRequired - displayTotalPaid;

      // Send receipt: Email first, SMS fallback if no email
      let emailResult = null;
      let smsResult = null;
      try {
        // Get receipt data
        const receiptData = await getReceiptData(paymentId, req.user.role, allocation.hostel_id);
        
        // Get student details for sending
        const [studentRows] = await db.execute(
          `SELECT s.id AS student_id, s.email, s.phone
           FROM students s
           JOIN allocations a ON s.id = a.student_id
           WHERE a.id = ? LIMIT 1`,
          [allocationId]
        );

        if (studentRows.length > 0) {
          const student = studentRows[0];

          // Try email first if student has email
          if (student.email) {
            try {
              // Create receipt HTML
              const receiptHTML = createReceiptHTML(receiptData);

              emailResult = await sendEmailWithHistory({
                studentId: student.student_id,
                email: student.email,
                messageType: 'RECEIPT',
                subject: `Payment Receipt - ${receiptData.receiptNumber} - ${receiptData.hostelName}`,
                html: receiptHTML,
                sentByUserId: req.user.sub,
              });
            } catch (emailError) {
              console.error('Failed to send receipt email:', emailError);
              // Fallback to SMS if email fails and phone exists
              if (student.phone) {
                try {
                  const smsReceipt = createSMSReceipt(receiptData);
                  smsResult = await sendSMSWithHistory({
                    studentId: student.student_id,
                    phone: student.phone,
                    messageType: 'RECEIPT',
                    message: smsReceipt,
                    sentByUserId: req.user.sub,
                  });
                } catch (smsError) {
                  console.error('Failed to send receipt SMS fallback:', smsError);
                }
              }
            }
          } else if (student.phone) {
            // No email, send SMS receipt
            try {
              const smsReceipt = createSMSReceipt(receiptData);
              smsResult = await sendSMSWithHistory({
                studentId: student.student_id,
                phone: student.phone,
                messageType: 'RECEIPT',
                message: smsReceipt,
                sentByUserId: req.user.sub,
              });
            } catch (smsError) {
              console.error('Failed to send receipt SMS:', smsError);
            }
          }
        }
      } catch (error) {
        // Log error but don't fail the payment
        console.error('Failed to send receipt:', error);
      }

      return res.status(201).json({
        message: 'Payment recorded',
        allocationId,
        paymentId,
        totalRequired,
        totalPaid,
        balance,
        receiptSent: emailResult?.success || smsResult?.success || false,
        emailSent: emailResult?.success || false,
        emailHistoryId: emailResult?.emailHistoryId || null,
        smsSent: smsResult?.success || false,
        smsHistoryId: smsResult?.smsHistoryId || null,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// All roles: view payments
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
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [req.user.hostelId]
        );
        activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
      }

      if (req.user.role === 'SUPER_ADMIN') {
        if (activeSemesterId) {
          [rows] = await db.execute(
            `SELECT p.id, p.allocation_id, p.semester_id, p.amount, p.recorded_by_user_id, p.recorded_at as created_at
             FROM payments p
             WHERE p.semester_id = ?
             ORDER BY p.recorded_at DESC`,
            [activeSemesterId]
          );
        } else {
          [rows] = await db.execute(
            `SELECT p.id, p.allocation_id, p.semester_id, p.amount, p.recorded_by_user_id, p.recorded_at as created_at
             FROM payments p
             ORDER BY p.recorded_at DESC`
          );
        }
      } else {
        // For CUSTODIAN and HOSTEL_OWNER, only show payments for their hostel and active semester
        if (activeSemesterId) {
          [rows] = await db.execute(
            `SELECT p.id, p.allocation_id, p.semester_id, p.amount, p.recorded_by_user_id, p.recorded_at as created_at
             FROM payments p
             JOIN allocations a ON p.allocation_id = a.id
             WHERE a.hostel_id = ? AND p.semester_id = ?
             ORDER BY p.recorded_at DESC`,
            [req.user.hostelId, activeSemesterId]
          );
        } else {
          rows = []; // No active semester
        }
      }
      
      return res.json(rows);
    } catch (err) {
      return next(err);
    }
  },
);

// All roles: view payment summary for an allocation
router.get(
  '/summary/:allocationId',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const allocationId = Number(req.params.allocationId);
      const db = getDb();

      const [allocRows] = await db.execute(
        `SELECT a.id, a.hostel_id, a.student_id, a.room_id, a.room_price_at_allocation, 
                s.full_name, s.registration_number,
                r.name AS room_name
         FROM allocations a
         JOIN students s ON a.student_id = s.id
         JOIN rooms r ON a.room_id = r.id
         WHERE a.id = ?
         LIMIT 1`,
        [allocationId],
      );
      if (!allocRows.length) {
        return res.status(404).json({ error: 'Allocation not found' });
      }

      const allocation = allocRows[0];
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) return res.status(400).json({ error: 'User is not linked to a hostel' });
        if (Number(allocation.hostel_id) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Allocation does not belong to your hostel' });
        }
      }

      const [totalRows] = await db.execute(
        'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE allocation_id = ?',
        [allocationId],
      );
      const totalPaid = Number(totalRows[0].total_paid || 0);
      const totalRequired = Number(allocation.room_price_at_allocation || 0);
      const balance = totalRequired - totalPaid;

      return res.json({
        allocationId: allocation.id,
        student: {
          id: allocation.student_id,
          fullName: allocation.full_name,
          registrationNumber: allocation.registration_number,
        },
        room: {
          id: allocation.room_id,
          name: allocation.room_name,
        },
        totalRequired,
        totalPaid,
        balance,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// All roles: get all allocations
router.get(
  '/allocations',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const db = getDb();
      
      // Normalize role for comparison (case-insensitive)
      const userRole = String(req.user.role).trim().toUpperCase();
      
      // Get active semester ID for filtering
      let activeSemesterId = null;
      if (userRole === 'SUPER_ADMIN') {
        const hostelId = req.query.hostelId ? Number(req.query.hostelId) : null;
        if (hostelId) {
          const [semRows] = await db.execute(
            'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
            [hostelId]
          );
          activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
        }
      } else {
        // Get hostelId from user (could be from JWT as hostelId or from req.user.hostelId)
        const userHostelId = req.user.hostelId || req.user.hostel_id;
        if (!userHostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        const [semRows] = await db.execute(
          'SELECT id FROM semesters WHERE hostel_id = ? AND is_active = 1 LIMIT 1',
          [userHostelId]
        );
        activeSemesterId = semRows.length > 0 ? semRows[0].id : null;
      }

      let rows;
      
      if (userRole === 'SUPER_ADMIN') {
        if (activeSemesterId) {
          [rows] = await db.execute(
            `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation, 
                    a.allocated_at as created_at
             FROM allocations a
             WHERE a.semester_id = ?
             ORDER BY a.allocated_at DESC`,
            [activeSemesterId]
          );
        } else {
          [rows] = await db.execute(
            `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation, 
                    a.allocated_at as created_at
             FROM allocations a
             ORDER BY a.allocated_at DESC`
          );
        }
      } else {
        // For CUSTODIAN and HOSTEL_OWNER, only show allocations for their hostel and active semester
        const userHostelId = req.user.hostelId || req.user.hostel_id;
        if (activeSemesterId && userHostelId) {
          [rows] = await db.execute(
            `SELECT a.id, a.hostel_id, a.semester_id, a.student_id, a.room_id, a.room_price_at_allocation,
                    a.allocated_at as created_at
             FROM allocations a
             WHERE a.hostel_id = ? AND a.semester_id = ?
             ORDER BY a.allocated_at DESC`,
            [userHostelId, activeSemesterId]
          );
        } else {
          rows = []; // No active semester or no hostel
        }
      }
      
      return res.json(rows);
    } catch (err) {
      console.error('Error in /allocations endpoint:', err);
      return next(err);
    }
  },
);

// Hostel Owner / Custodian: check out student (delete allocation)
router.delete(
  '/allocations/:allocationId',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const allocationId = Number(req.params.allocationId);
      const db = getDb();

      // Verify allocation exists and belongs to user's hostel
      const [allocRows] = await db.execute(
        'SELECT id, hostel_id, student_id, room_id FROM allocations WHERE id = ? LIMIT 1',
        [allocationId],
      );

      if (!allocRows.length) {
        return res.status(404).json({ error: 'Allocation not found' });
      }

      const allocation = allocRows[0];

      // Check authorization
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(allocation.hostel_id) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Allocation does not belong to your hostel' });
        }
      }

      // Delete allocation
      await db.execute('DELETE FROM allocations WHERE id = ?', [allocationId]);

      await writeAuditLog(db, req, {
        action: 'STUDENT_CHECKED_OUT',
        entityType: 'allocation',
        entityId: allocationId,
        details: { 
          hostelId: allocation.hostel_id, 
          studentId: allocation.student_id, 
          roomId: allocation.room_id 
        },
      });

      return res.status(200).json({ message: 'Student checked out successfully' });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;

