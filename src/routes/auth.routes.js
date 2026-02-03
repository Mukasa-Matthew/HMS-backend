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
  console.error(
    'Please set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in your .env file',
  );
  process.exit(1);
}

/**
 * Cookie options helper
 *
 * - When the API is served over HTTPS (behind a proxy / on production),
 *   we must use SameSite=None; Secure so that cookies can be sent from
 *   the Netlify frontend (https://marthms.netlify.app) to the API
 *   (https://hmsapi.martomor.xyz).
 * - For local development over http://localhost we fall back to
 *   SameSite=Lax and secure=false so cookies still work.
 */
function getCookieBaseOptions(req) {
  // Check multiple ways to detect HTTPS (for different proxy configurations)
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedSsl = req.headers['x-forwarded-ssl'];
  const host = req.headers.host || '';
  
  // Detect if we're in production (HTTPS API domain)
  const isProductionDomain = host.includes('hmsapi.martomor.xyz') || 
                             host.includes('martomor.xyz');
  
  const isSecure =
    req.secure ||
    forwardedProto === 'https' ||
    forwardedSsl === 'on' ||
    forwardedProto?.includes('https') ||
    isProductionDomain; // If it's the production domain, assume HTTPS

  // Always use SameSite=None; Secure for cross-site cookies in production
  // For localhost, use Lax
  const isLocalhost = host.includes('localhost') || host.includes('127.0.0.1');
  const useCrossSiteCookies = isSecure && !isLocalhost;
  
  const sameSite = useCrossSiteCookies ? 'none' : 'lax';
  const secure = useCrossSiteCookies; // Must be true for SameSite=None

  // Debug logging (remove in production if too verbose)
  if (process.env.DEBUG_COOKIES === 'true') {
    console.log('Cookie options:', {
      host,
      isProductionDomain,
      isLocalhost,
      isSecure,
      sameSite,
      secure,
      forwardedProto,
      reqSecure: req.secure,
      nodeEnv: process.env.NODE_ENV,
    });
  }

  return {
    httpOnly: true,
    secure: secure, // Must be true for SameSite=None
    sameSite: sameSite,
    // Don't set domain - let browser handle it for cross-site cookies
    // path: '/' is default, which is what we want
  };
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

    const baseCookieOptions = getCookieBaseOptions(req);

    // Debug: Log cookie options being used
    if (process.env.DEBUG_COOKIES === 'true') {
      console.log('Setting cookies with options:', {
        ...baseCookieOptions,
        accessTokenLength: accessToken.length,
        refreshTokenLength: refreshToken.length,
        origin: req.headers.origin,
        host: req.headers.host,
      });
    }

    // Set httpOnly cookies so frontend JS cannot read tokens directly
    res.cookie('hms_access', accessToken, {
      ...baseCookieOptions,
      maxAge: 1000 * 60 * 15, // 15 minutes
    });
    res.cookie('hms_refresh', refreshToken, {
      ...baseCookieOptions,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });

    // Log that cookies were set (for debugging)
    console.log(`Cookies set for user ${user.username} - SameSite: ${baseCookieOptions.sameSite}, Secure: ${baseCookieOptions.secure}`);

    await writeAuditLog(db, req, {
      action: 'LOGIN_SUCCESS',
      entityType: 'user',
      entityId: user.id,
      details: { username: user.username, role: user.role, hostelId: user.hostel_id || null },
    });

    // Return user info and tokens (tokens also in cookies, but this is a fallback)
    // Frontend should prefer cookies, but can use these if cookies fail
    return res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        hostelId: user.hostel_id || null,
      },
      // Temporary fallback: include tokens in response if cookies fail
      // Frontend should check cookies first, then fall back to these
      accessToken: accessToken,
      refreshToken: refreshToken,
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

    // Debug logging for cookie issues
    if (process.env.DEBUG_COOKIES === 'true') {
      console.log('Refresh endpoint:', {
        hasCookie: !!refreshTokenFromCookie,
        hasBodyToken: !!refreshTokenFromBody,
        cookies: Object.keys(req.cookies || {}),
        origin: req.headers.origin,
        referer: req.headers.referer,
      });
    }

    if (!token) {
      // More detailed error for debugging
      const errorMsg = refreshTokenFromCookie
        ? 'Refresh token cookie exists but is invalid'
        : 'Refresh token is required (no cookie or body token)';
      if (process.env.DEBUG_COOKIES === 'true') {
        console.log('Refresh failed:', errorMsg, {
          cookies: req.cookies,
          body: req.body,
        });
      }
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

      const baseCookieOptions = getCookieBaseOptions(req);

      res.cookie('hms_access', accessToken, {
        ...baseCookieOptions,
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

    // Clear cookies using same attributes they were set with
    const baseCookieOptions = getCookieBaseOptions(req);

    res.clearCookie('hms_access', baseCookieOptions);
    res.clearCookie('hms_refresh', baseCookieOptions);

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

// Comprehensive diagnostic endpoint
router.get('/diagnostics', (req, res) => {
  const baseCookieOptions = getCookieBaseOptions(req);
  
  // Try to set a test cookie
  res.cookie('test_cookie', 'test_value_' + Date.now(), {
    ...baseCookieOptions,
    maxAge: 1000 * 60, // 1 minute
  });

  return res.json({
    message: 'Diagnostic information',
    receivedCookies: req.cookies || {},
    cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
    cookieOptions: baseCookieOptions,
    requestInfo: {
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      'user-agent': req.headers['user-agent'],
      'x-forwarded-proto': req.headers['x-forwarded-proto'],
      'x-forwarded-ssl': req.headers['x-forwarded-ssl'],
    },
    serverInfo: {
      secure: req.secure,
      nodeEnv: process.env.NODE_ENV,
      hasAccessToken: !!req.cookies?.hms_access,
      hasRefreshToken: !!req.cookies?.hms_refresh,
    },
    instructions: {
      step1: 'Check if test_cookie appears in your browser DevTools → Application → Cookies',
      step2: 'If test_cookie is NOT visible, cookies are being blocked',
      step3: 'Check browser settings: Allow third-party cookies must be enabled',
      step4: 'Check if SameSite=None and Secure flags are set correctly',
    },
  });
});

module.exports = router;

