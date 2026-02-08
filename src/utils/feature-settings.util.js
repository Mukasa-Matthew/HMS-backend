const { getDb } = require('../config/db');

/**
 * Check if Hostel Owners can view payment amounts for students
 * @param {number} hostelId - Hostel ID
 * @returns {Promise<boolean>} - true if owners can view payment amounts, false otherwise (default: true)
 */
async function canOwnerViewPaymentAmounts(hostelId) {
  if (!hostelId) {
    return true; // Default to true if no hostel ID
  }

  try {
    const db = getDb();
    const [settings] = await db.execute(
      `SELECT enabled_for_owner 
       FROM hostel_feature_settings 
       WHERE hostel_id = ? AND feature_name = 'owner_view_payment_amounts'
       LIMIT 1`,
      [hostelId]
    );

    // If setting exists, return its value; otherwise default to true
    if (settings.length > 0) {
      return Boolean(settings[0].enabled_for_owner);
    }

    // Default to true if setting doesn't exist (backward compatibility)
    return true;
  } catch (error) {
    console.error('Error checking owner_view_payment_amounts setting:', error);
    // Default to true on error to avoid breaking existing functionality
    return true;
  }
}

/**
 * Check if custodians can set display prices different from actual prices
 * @param {number} hostelId - Hostel ID
 * @returns {Promise<boolean>} - true if markup is allowed, false otherwise (default: false)
 */
async function isCustodianPriceMarkupEnabled(hostelId) {
  if (!hostelId) {
    return false; // Default to false if no hostel ID
  }

  try {
    const db = getDb();
    const [settings] = await db.execute(
      `SELECT enabled_for_custodian 
       FROM hostel_feature_settings 
       WHERE hostel_id = ? AND feature_name = 'allow_custodian_price_markup'
       LIMIT 1`,
      [hostelId]
    );

    // If setting exists, return its value; otherwise default to false
    if (settings.length > 0) {
      return Boolean(settings[0].enabled_for_custodian);
    }

    // Default to false if setting doesn't exist (opt-in feature)
    return false;
  } catch (error) {
    console.error('Error checking allow_custodian_price_markup setting:', error);
    // Default to false on error (opt-in feature)
    return false;
  }
}

module.exports = {
  canOwnerViewPaymentAmounts,
  isCustodianPriceMarkupEnabled,
};
