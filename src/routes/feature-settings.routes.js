const express = require('express');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

// Feature names that can be toggled
const VALID_FEATURES = [
  'students',
  'rooms',
  'payments',
  'checkin_checkout',
  'semesters',
  'receipts',
  'dashboard_quick_actions', // Quick action buttons on dashboard
];

const updateFeatureSettingsSchema = Joi.object({
  features: Joi.array()
    .items(
      Joi.object({
        featureName: Joi.string()
          .valid(...VALID_FEATURES)
          .required(),
        enabledForOwner: Joi.boolean().required(),
        enabledForCustodian: Joi.boolean().required(),
      }),
    )
    .min(1)
    .required(),
});

// Get feature settings for a hostel
router.get(
  '/hostel/:hostelId',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN']),
  async (req, res, next) => {
    try {
      const hostelId = Number(req.params.hostelId);
      const db = getDb();

      // Verify hostel exists
      const [hostelRows] = await db.execute('SELECT id FROM hostels WHERE id = ? LIMIT 1', [hostelId]);
      if (hostelRows.length === 0) {
        return res.status(404).json({ error: 'Hostel not found' });
      }

      // Get existing settings
      const [settings] = await db.execute(
        'SELECT feature_name, enabled_for_owner, enabled_for_custodian FROM hostel_feature_settings WHERE hostel_id = ?',
        [hostelId],
      );

      // Create a map of existing settings
      const settingsMap = {};
      settings.forEach((s) => {
        settingsMap[s.feature_name] = {
          enabledForOwner: Boolean(s.enabled_for_owner),
          enabledForCustodian: Boolean(s.enabled_for_custodian),
        };
      });

      // Return all features with defaults (enabled) if not set
      const allFeatures = VALID_FEATURES.map((featureName) => ({
        featureName,
        enabledForOwner: settingsMap[featureName]?.enabledForOwner ?? true,
        enabledForCustodian: settingsMap[featureName]?.enabledForCustodian ?? true,
      }));

      return res.json({ hostelId, features: allFeatures });
    } catch (err) {
      return next(err);
    }
  },
);

// Get feature settings for current user's hostel (for owners/custodians)
router.get(
  '/my-hostel',
  authenticateToken,
  authorizeRoles(['HOSTEL_OWNER', 'CUSTODIAN']),
  async (req, res, next) => {
    try {
      if (!req.user.hostelId) {
        return res.status(400).json({ error: 'User is not linked to a hostel' });
      }

      const db = getDb();
      const hostelId = req.user.hostelId;

      // Get existing settings
      const [settings] = await db.execute(
        'SELECT feature_name, enabled_for_owner, enabled_for_custodian FROM hostel_feature_settings WHERE hostel_id = ?',
        [hostelId],
      );

      // Create a map of existing settings
      const settingsMap = {};
      settings.forEach((s) => {
        settingsMap[s.feature_name] = {
          enabledForOwner: Boolean(s.enabled_for_owner),
          enabledForCustodian: Boolean(s.enabled_for_custodian),
        };
      });

      // Return features based on user role
      // Custodians always see all features (enabledForCustodian is always true by default)
      // Owners see features based on enabledForOwner setting
      const userRole = req.user.role;
      const allFeatures = VALID_FEATURES.map((featureName) => {
        const setting = settingsMap[featureName];
        if (userRole === 'CUSTODIAN') {
          // Custodians always have access (default true, but respect setting if explicitly disabled)
          return {
            featureName,
            enabled: setting ? Boolean(setting.enabledForCustodian) : true,
          };
        } else {
          // Owners see based on enabledForOwner (default true)
          return {
            featureName,
            enabled: setting ? Boolean(setting.enabledForOwner) : true,
          };
        }
      });

      return res.json({ hostelId, features: allFeatures });
    } catch (err) {
      return next(err);
    }
  },
);

// Update feature settings for a hostel
router.put(
  '/hostel/:hostelId',
  authenticateToken,
  authorizeRoles(['SUPER_ADMIN']),
  async (req, res, next) => {
    try {
      const hostelId = Number(req.params.hostelId);
      const { error, value } = updateFeatureSettingsSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const db = getDb();

      // Verify hostel exists
      const [hostelRows] = await db.execute('SELECT id FROM hostels WHERE id = ? LIMIT 1', [hostelId]);
      if (hostelRows.length === 0) {
        return res.status(404).json({ error: 'Hostel not found' });
      }

      // Start transaction
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // Update or insert each feature setting
        for (const feature of value.features) {
          await conn.execute(
            `INSERT INTO hostel_feature_settings (hostel_id, feature_name, enabled_for_owner, enabled_for_custodian)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               enabled_for_owner = VALUES(enabled_for_owner),
               enabled_for_custodian = VALUES(enabled_for_custodian),
               updated_at = CURRENT_TIMESTAMP`,
            [
              hostelId,
              feature.featureName,
              feature.enabledForOwner ? 1 : 0,
              feature.enabledForCustodian ? 1 : 0,
            ],
          );
        }

        await conn.commit();

        await writeAuditLog(db, req, {
          action: 'FEATURE_SETTINGS_UPDATED',
          entityType: 'hostel',
          entityId: hostelId,
          details: { features: value.features },
        });

        return res.json({ message: 'Feature settings updated successfully' });
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

module.exports = router;
