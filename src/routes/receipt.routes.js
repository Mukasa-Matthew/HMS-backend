const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { getReceiptData, createReceiptHTML } = require('../utils/receipt.util');
const { getDb } = require('../config/db');

const router = express.Router();

// Get receipt preview (HTML)
router.get(
  '/:paymentId/preview',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const paymentId = Number(req.params.paymentId);
      if (!paymentId || isNaN(paymentId)) {
        return res.status(400).json({ error: 'Invalid payment ID' });
      }

      const db = getDb();
      
      // Verify payment exists and user has access
      const [paymentRows] = await db.execute(
        `SELECT p.id, a.hostel_id 
         FROM payments p
         JOIN allocations a ON p.allocation_id = a.id
         WHERE p.id = ? LIMIT 1`,
        [paymentId]
      );

      if (paymentRows.length === 0) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      const payment = paymentRows[0];
      
      // Check access
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(payment.hostel_id) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Payment does not belong to your hostel' });
        }
      }

      // Get receipt data
      const receiptData = await getReceiptData(paymentId, req.user.role, req.user.hostelId);
      
      // Generate HTML
      const html = createReceiptHTML(receiptData);

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      return next(err);
    }
  }
);

// Get receipt data (JSON) for frontend rendering
router.get(
  '/:paymentId',
  authenticateToken,
  authorizeRoles(['CUSTODIAN', 'SUPER_ADMIN', 'HOSTEL_OWNER']),
  async (req, res, next) => {
    try {
      const paymentId = Number(req.params.paymentId);
      if (!paymentId || isNaN(paymentId)) {
        return res.status(400).json({ error: 'Invalid payment ID' });
      }

      const db = getDb();
      
      // Verify payment exists and user has access
      const [paymentRows] = await db.execute(
        `SELECT p.id, a.hostel_id 
         FROM payments p
         JOIN allocations a ON p.allocation_id = a.id
         WHERE p.id = ? LIMIT 1`,
        [paymentId]
      );

      if (paymentRows.length === 0) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      const payment = paymentRows[0];
      
      // Check access
      if (req.user.role !== 'SUPER_ADMIN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        if (Number(payment.hostel_id) !== Number(req.user.hostelId)) {
          return res.status(403).json({ error: 'Payment does not belong to your hostel' });
        }
      }

      // Get receipt data
      const receiptData = await getReceiptData(paymentId, req.user.role, req.user.hostelId);

      res.json(receiptData);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
