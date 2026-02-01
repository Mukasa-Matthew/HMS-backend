const express = require('express');
const { getDb } = require('../config/db');
const { hashPassword, comparePassword } = require('../utils/password.util');
const { sendOTP, formatPhoneNumber } = require('../services/sms.service');
const crypto = require('crypto');

const router = express.Router();

// Rate limiting: Store recent requests in memory (in production, use Redis)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_HOUR = 3;

function checkRateLimit(phone) {
  const now = Date.now();
  const key = phone;
  
  if (rateLimitStore.has(key)) {
    const requests = rateLimitStore.get(key);
    const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= MAX_REQUESTS_PER_HOUR) {
      return false; // Rate limit exceeded
    }
    
    recentRequests.push(now);
    rateLimitStore.set(key, recentRequests);
  } else {
    rateLimitStore.set(key, [now]);
  }
  
  // Clean up old entries periodically
  if (Math.random() < 0.01) { // 1% chance to clean up
    for (const [k, v] of rateLimitStore.entries()) {
      const filtered = v.filter(time => now - time < RATE_LIMIT_WINDOW);
      if (filtered.length === 0) {
        rateLimitStore.delete(k);
      } else {
        rateLimitStore.set(k, filtered);
      }
    }
  }
  
  return true; // Within rate limit
}

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * POST /api/password-reset/request
 * Request password reset OTP
 */
router.post('/request', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Format phone number
    const formattedPhone = formatPhoneNumber(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Check rate limit
    if (!checkRateLimit(formattedPhone)) {
      return res.status(429).json({ 
        error: 'Too many requests. Please wait before requesting another OTP.' 
      });
    }

    const pool = getDb();

    // Check if user exists with this phone number
    const [users] = await pool.query(
      'SELECT id, username, phone FROM users WHERE phone = ? AND is_active = 1',
      [formattedPhone]
    );

    if (users.length === 0) {
      // Don't reveal if phone exists or not for security
      // But still return success to prevent phone enumeration
      return res.status(200).json({ 
        message: 'If this phone number is registered, an OTP has been sent.' 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpHash = await hashPassword(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate any previous unused OTPs for this phone
    await pool.query(
      'UPDATE password_resets SET used = 1 WHERE phone = ? AND used = 0',
      [formattedPhone]
    );

    // Store OTP
    await pool.query(
      `INSERT INTO password_resets (phone, otp_hash, expires_at, used)
       VALUES (?, ?, ?, 0)`,
      [formattedPhone, otpHash, expiresAt]
    );

    // Send OTP via SMS
    try {
      await sendOTP(formattedPhone, otp);
    } catch (smsError) {
      console.error('Failed to send OTP SMS:', smsError);
      // Still return success to prevent phone enumeration
      // In production, you might want to log this for monitoring
      return res.status(200).json({ 
        message: 'If this phone number is registered, an OTP has been sent.' 
      });
    }

    res.status(200).json({ 
      message: 'If this phone number is registered, an OTP has been sent.' 
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

/**
 * POST /api/password-reset/verify
 * Verify OTP
 */
router.post('/verify', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone number and OTP are required' });
    }

    const formattedPhone = formatPhoneNumber(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'OTP must be 6 digits' });
    }

    const pool = getDb();

    // Find valid, unused OTP
    const [resets] = await pool.query(
      `SELECT id, otp_hash, expires_at 
       FROM password_resets 
       WHERE phone = ? AND used = 0 AND expires_at > NOW()
       ORDER BY created_at DESC 
       LIMIT 1`,
      [formattedPhone]
    );

    if (resets.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    const resetRecord = resets[0];

    // Verify OTP
    const isValid = await comparePassword(otp, resetRecord.otp_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Mark OTP as used
    await pool.query(
      'UPDATE password_resets SET used = 1 WHERE id = ?',
      [resetRecord.id]
    );

    // Generate a temporary reset token (valid for 15 minutes)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store reset token (we'll use the same table, but mark it differently)
    // For simplicity, we'll use a separate approach: store token in a new column
    // But for now, let's use a simple approach: return token and verify phone on reset
    
    // Actually, let's use a simpler approach: return success and verify phone+otp again on reset
    // Or better: store a reset_token in the password_resets table
    await pool.query(
      `UPDATE password_resets 
       SET used = 1 
       WHERE id = ?`,
      [resetRecord.id]
    );

    // Create a reset session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Store session token (we'll verify this on password reset)
    await pool.query(
      `INSERT INTO password_resets (phone, otp_hash, expires_at, used)
       VALUES (?, ?, ?, 0)`,
      [formattedPhone, await hashPassword(sessionToken), sessionExpiresAt]
    );

    res.status(200).json({ 
      message: 'OTP verified successfully',
      resetToken: sessionToken,
      expiresAt: sessionExpiresAt.toISOString()
    });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

/**
 * POST /api/password-reset/reset
 * Reset password with verified token
 */
router.post('/reset', async (req, res) => {
  try {
    const { phone, resetToken, newPassword } = req.body;

    if (!phone || !resetToken || !newPassword) {
      return res.status(400).json({ error: 'Phone number, reset token, and new password are required' });
    }

    const formattedPhone = formatPhoneNumber(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Validate password strength
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const pool = getDb();

    // Verify reset token
    const [resets] = await pool.query(
      `SELECT id, otp_hash, expires_at 
       FROM password_resets 
       WHERE phone = ? AND used = 0 AND expires_at > NOW()
       ORDER BY created_at DESC 
       LIMIT 1`,
      [formattedPhone]
    );

    if (resets.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const resetRecord = resets[0];

    // Verify token
    const isValid = await comparePassword(resetToken, resetRecord.otp_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    // Find user by phone
    const [users] = await pool.query(
      'SELECT id FROM users WHERE phone = ? AND is_active = 1',
      [formattedPhone]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = users[0].id;

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update user password
    await pool.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, userId]
    );

    // Mark reset token as used
    await pool.query(
      'UPDATE password_resets SET used = 1 WHERE id = ?',
      [resetRecord.id]
    );

    // Invalidate all other reset tokens for this user
    await pool.query(
      'UPDATE password_resets SET used = 1 WHERE phone = ? AND used = 0',
      [formattedPhone]
    );

    res.status(200).json({ 
      message: 'Password reset successfully' 
    });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
