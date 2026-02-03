const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

if (!ACCESS_SECRET) {
  console.error('ERROR: JWT_ACCESS_SECRET is required!');
  console.error('Please set JWT_ACCESS_SECRET in your .env file');
  process.exit(1);
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  // Fallback to httpOnly cookie (preferred in browser)
  if (req.cookies && req.cookies.hms_access) {
    return req.cookies.hms_access;
  }
  return null;
}

function authenticateToken(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    // Only log in development or when explicitly debugging
    if (process.env.DEBUG_COOKIES === 'true') {
      console.log('Auth failed - No token found:', {
        path: req.path,
        method: req.method,
        hasAuthHeader: !!req.headers.authorization,
        hasCookies: !!req.cookies,
        cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
      });
    }
    return res.status(401).json({ error: 'Authentication token missing' });
  }

  jwt.verify(token, ACCESS_SECRET, (err, user) => {
    if (err) {
      if (process.env.DEBUG_COOKIES === 'true') {
        console.log('Token verification failed:', {
          path: req.path,
          error: err.message,
        });
      }
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    return next();
  });
}

function authorizeRoles(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      console.error('Authorization failed: Missing user or role', { 
        hasUser: !!req.user, 
        userRole: req.user?.role,
        path: req.path,
        method: req.method,
        userId: req.user?.sub
      });
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Normalize role comparison (trim and case-insensitive)
    const userRole = String(req.user.role).trim().toUpperCase();
    const normalizedAllowedRoles = allowedRoles.map(r => String(r).trim().toUpperCase());

    if (!normalizedAllowedRoles.includes(userRole)) {
      console.error('Authorization failed: Role not allowed', { 
        userRole: req.user.role,
        normalizedUserRole: userRole,
        allowedRoles,
        normalizedAllowedRoles,
        path: req.path,
        method: req.method,
        userId: req.user?.sub
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return next();
  };
}

module.exports = {
  authenticateToken,
  authorizeRoles,
};

