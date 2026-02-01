const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

const roomSchema = Joi.object({
  name: Joi.string().max(100).required(),
  price: Joi.number().precision(2).min(0).required(),
  capacity: Joi.number().integer().min(1).required(),
  hostelId: Joi.number().integer().optional(), // for SUPER_ADMIN only
  isActive: Joi.boolean().default(true),
});

// Super Admin / Hostel Owner / Custodian: manage rooms
router.post(
  '/',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const { error, value } = roomSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }
      const { name, price, capacity, hostelId, isActive } = value;
      const db = getDb();

      let effectiveHostelId = null;
      if (req.user.role === 'SUPER_ADMIN') {
        if (!hostelId) {
          return res.status(400).json({ error: 'hostelId is required when creating a room' });
        }
        const [hostelRows] = await db.execute(
          'SELECT id FROM hostels WHERE id = ? LIMIT 1',
          [hostelId],
        );
        if (!hostelRows.length) {
          return res.status(400).json({ error: 'Invalid hostelId' });
        }
        effectiveHostelId = hostelId;
      } else if (req.user.role === 'HOSTEL_OWNER' || req.user.role === 'CUSTODIAN') {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        effectiveHostelId = req.user.hostelId;
      }

      await db.execute(
        'INSERT INTO rooms (name, price, capacity, hostel_id, is_active) VALUES (?, ?, ?, ?, ?)',
        [name, price, capacity, effectiveHostelId, isActive ? 1 : 0],
      );

      await writeAuditLog(db, req, {
        action: 'ROOM_CREATED',
        entityType: 'room',
        details: { name, price, capacity, hostelId: effectiveHostelId, isActive: isActive ? 1 : 0 },
      });
      return res.status(201).json({ message: 'Room created' });
    } catch (err) {
      return next(err);
    }
  },
);

router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();
    let rows;
    if (req.user.role === 'SUPER_ADMIN') {
      [rows] = await db.execute(
        'SELECT id, name, price, capacity, hostel_id, is_active FROM rooms WHERE is_active = 1 ORDER BY name',
      );
    } else if (req.user.hostelId) {
      [rows] = await db.execute(
        'SELECT id, name, price, capacity, hostel_id, is_active FROM rooms WHERE is_active = 1 AND hostel_id = ? ORDER BY name',
        [req.user.hostelId],
      );
    } else {
      rows = [];
    }
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// Update room price
const updatePriceSchema = Joi.object({
  price: Joi.number().precision(2).min(0).required(),
  effectiveDate: Joi.string().isoDate().optional(),
});

router.patch(
  '/:id',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const roomId = Number(req.params.id);
      const { error, value } = updatePriceSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { price } = value;
      const db = getDb();

      // Verify room exists and belongs to user's hostel
      let roomRows;
      if (req.user.role === 'SUPER_ADMIN') {
        [roomRows] = await db.execute(
          'SELECT id, hostel_id, name, price FROM rooms WHERE id = ? LIMIT 1',
          [roomId],
        );
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        [roomRows] = await db.execute(
          'SELECT id, hostel_id, name, price FROM rooms WHERE id = ? AND hostel_id = ? LIMIT 1',
          [roomId, req.user.hostelId],
        );
      }

      if (!roomRows.length) {
        return res.status(404).json({ error: 'Room not found or access denied' });
      }

      const room = roomRows[0];
      const oldPrice = room.price;

      // Update room price
      await db.execute('UPDATE rooms SET price = ? WHERE id = ?', [price, roomId]);

      await writeAuditLog(db, req, {
        action: 'ROOM_PRICE_UPDATED',
        entityType: 'room',
        entityId: roomId,
        details: { 
          roomId, 
          roomName: room.name,
          oldPrice, 
          newPrice: price,
          hostelId: room.hostel_id 
        },
      });

      return res.json({ 
        message: 'Room price updated successfully',
        room: {
          id: roomId,
          name: room.name,
          price: price,
        }
      });
    } catch (err) {
      return next(err);
    }
  },
);

// Also support PUT for backward compatibility
router.put(
  '/:id',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN', 'HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      const roomId = Number(req.params.id);
      const { error, value } = updatePriceSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { price } = value;
      const db = getDb();

      // Verify room exists and belongs to user's hostel
      let roomRows;
      if (req.user.role === 'SUPER_ADMIN') {
        [roomRows] = await db.execute(
          'SELECT id, hostel_id, name, price FROM rooms WHERE id = ? LIMIT 1',
          [roomId],
        );
      } else {
        if (!req.user.hostelId) {
          return res.status(400).json({ error: 'User is not linked to a hostel' });
        }
        [roomRows] = await db.execute(
          'SELECT id, hostel_id, name, price FROM rooms WHERE id = ? AND hostel_id = ? LIMIT 1',
          [roomId, req.user.hostelId],
        );
      }

      if (!roomRows.length) {
        return res.status(404).json({ error: 'Room not found or access denied' });
      }

      const room = roomRows[0];
      const oldPrice = room.price;

      // Update room price
      await db.execute('UPDATE rooms SET price = ? WHERE id = ?', [price, roomId]);

      await writeAuditLog(db, req, {
        action: 'ROOM_PRICE_UPDATED',
        entityType: 'room',
        entityId: roomId,
        details: { 
          roomId, 
          roomName: room.name,
          oldPrice, 
          newPrice: price,
          hostelId: room.hostel_id 
        },
      });

      return res.json({ 
        message: 'Room price updated successfully',
        room: {
          id: roomId,
          name: room.name,
          price: price,
        }
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;

