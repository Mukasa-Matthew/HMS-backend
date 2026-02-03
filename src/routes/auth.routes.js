const express = require('express');
const jwt = require('jsonwebtoken');
const Joi = require('joi');

const { getDb } = require('../config/db');
const { comparePassword } = require('../utils/password.util');
const { authenticateToken } = require('../middleware/auth.middleware');
const { writeAuditLog } = require('../utils/audit.util');

const router = express.Router();

// JWT secrets must be provided via environment variables
// No default values for security - will throw error if not set
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  console.error('ERROR: JWT secrets are required!');
  console.error('Please set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in your .env file');
  process.exit(1);
}

const loginSchema = Joi.object({
  username: Joi.string().max(100).required(),
  password: Joi.string().min(6).max(128).required(),
});

router.post('/login', async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { username, password } = value;
    const db = getDb();

    // Trim username/phone to handle whitespace issues
    const trimmedInput = username.trim();

    // Try to find user by either username or phone number
    const [rows] = await db.execute(
      'SELECT u.id, u.username, u.phone, u.password_hash, u.hostel_id, u.is_active, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = ? OR u.phone = ? LIMIT 1',
      [trimmedInput, trimmedInput],
    );

    if (!rows.length) {
      console.log(`Login failed: User not found - ${trimmedInput}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    
    // Check if user is active
    if (!user.is_active || user.is_active === 0) {
      console.log(`Login failed: Account inactive - ${trimmedInput}`);
      return res.status(401).json({ error: 'Account is inactive. Please contact an administrator.' });
    }

    // Check if password_hash exists
    if (!user.password_hash) {
      console.log(`Login failed: No password hash - ${trimmedInput}`);
      return res.status(401).json({ error: 'Account configuration error. Please contact an administrator.' });
    }

    // Trim password and compare
    const trimmedPassword = password.trim();
    const valid = await comparePassword(trimmedPassword, user.password_hash);
    
    if (!valid) {
      console.log(`Login failed: Invalid password - ${trimmedInput}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Log successful login for debugging
    console.log(`Login successful for user: ${user.username} (login with: ${trimmedInput}), role: ${user.role}, hostel_id: ${user.hostel_id}`);

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      hostelId: user.hostel_id || null,
    };

    const accessToken = jwt.sign(payload, ACCESS_SECRET, {
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    });
    const refreshToken = jwt.sign(payload, REFRESH_SECRET, {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const sameSite = isProduction ? 'none' : 'lax';

    // Set httpOnly cookies so frontend JS cannot read tokens directly
    res.cookie('hms_access', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite,
      maxAge: 1000 * 60 * 15, // 15 minutes
    });
    res.cookie('hms_refresh', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });

    await writeAuditLog(db, req, {
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      details: { username: user.username, role: user.role, hostelId: user.hostel_id || null },
    });

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
          hostelId: user.hostel_id || null,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const refreshTokenFromBody = req.body?.refreshToken;
    const refreshTokenFromCookie = req.cookies?.hms_refresh;
    const token = refreshTokenFromCookie || refreshTokenFromBody;

    if (!token) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    jwt.verify(token, REFRESH_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired refresh token' });
      }

      const payload = {
        sub: user.sub,
        username: user.username,
        role: user.role,
        hostelId: user.hostelId ?? null,
      };

      const accessToken = jwt.sign(payload, ACCESS_SECRET, {
        expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
      });

      const isProduction = process.env.NODE_ENV === 'production';
      const sameSite = isProduction ? 'none' : 'lax';

      res.cookie('hms_access', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite,
        maxAge: 1000 * 60 * 15,
      });

      return res.json({ ok: true });
    });
  } catch (err) {
    return next(err);
  }
});

// Logout endpoint - clears cookies
router.post('/logout', authenticateToken, async (req, res, next) => {
  try {
    const db = getDb();
    await writeAuditLog(db, req, {
      action: 'LOGOUT',
      entityType: 'user',
      entityId: req.user?.sub || null,
      details: { username: req.user?.username || null },
    });

    // Clear cookies
    const isProduction = process.env.NODE_ENV === 'production';
    const sameSite = isProduction ? 'none' : 'lax';

    res.clearCookie('hms_access', {
      httpOnly: true,
      secure: isProduction,
      sameSite,
    });
    res.clearCookie('hms_refresh', {
      httpOnly: true,
      secure: isProduction,
      sameSite,
    });

    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    return next(err);
  }
});

// Return current authenticated user based on token/cookie
router.get('/me', authenticateToken, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  return res.json({
    id: req.user.sub,
    username: req.user.username,
    role: req.user.role,
    hostelId: req.user.hostelId ?? null,
  });
});

module.exports = router;

