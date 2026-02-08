require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const { initDb } = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const roomRoutes = require('./routes/room.routes');
const hostelRoutes = require('./routes/hostel.routes');
const auditRoutes = require('./routes/audit.routes');
const studentRoutes = require('./routes/student.routes');
const paymentRoutes = require('./routes/payment.routes');
const receiptRoutes = require('./routes/receipt.routes');
const semesterRoutes = require('./routes/semester.routes');
const checkInRoutes = require('./routes/checkin.routes');
const featureSettingsRoutes = require('./routes/feature-settings.routes');
const expenseRoutes = require('./routes/expense.routes');
const passwordResetRoutes = require('./routes/password-reset.routes');

const app = express();

// Trust proxy - needed when behind reverse proxy (nginx, load balancer, etc.)
// This allows req.secure and req.headers['x-forwarded-proto'] to work correctly
app.set('trust proxy', 1);

// Core security middlewares (similar intent to Java EE security filters)
// Helmet helps secure Express apps by setting various HTTP headers
app.use(
  helmet({
    // Allow cookies to work cross-site (needed for Netlify frontend)
    crossOriginEmbedderPolicy: false,
    // Configure CSP to allow necessary resources
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  }),
);

// CORS configuration - always include Netlify URL
const getCorsOrigins = () => {
  const netlifyUrl = 'https://marthms.netlify.app';
  const defaultOrigins = [
    'http://localhost:3000',
    'http://localhost:4000',
    netlifyUrl,
  ];

  if (process.env.ALLOWED_ORIGINS) {
    const envOrigins = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    // Merge and deduplicate, ensuring Netlify URL is always included
    const allOrigins = [...new Set([...envOrigins, ...defaultOrigins])];
    return allOrigins;
  }

  return defaultOrigins;
};

app.use(
  cors({
    origin: getCorsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);
// Logging - use 'combined' in production for better logs
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Request size limits to prevent DoS attacks
app.use(express.json({ limit: '10mb' })); // Limit JSON payloads
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Limit URL-encoded payloads
app.use(cookieParser());

// Debug middleware to log all incoming cookies (only if DEBUG_COOKIES is enabled)
if (process.env.DEBUG_COOKIES === 'true') {
  app.use((req, res, next) => {
    if (req.cookies && Object.keys(req.cookies).length > 0) {
      console.log('Incoming request cookies:', {
        path: req.path,
        cookies: Object.keys(req.cookies),
        origin: req.headers.origin,
      });
    }
    next();
  });
}

// Initialize database connection pool on startup
initDb()
  .then(() => {
    console.log('Database pool initialized');
  })
  .catch((err) => {
    console.error('Failed to initialize database pool', err);
    process.exit(1);
  });

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/hostels', hostelRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/semesters', semesterRoutes);
app.use('/api/check-ins', checkInRoutes);
app.use('/api/feature-settings', featureSettingsRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/password-reset', passwordResetRoutes);
app.use('/api/owner', studentRoutes); // Owner-specific endpoints

// Global error handler (similar to Java exception mappers)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log error with context (but don't expose sensitive details)
  const status = err.status || 500;
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Log full error in development, sanitized in production
  if (isDevelopment) {
    console.error('Error:', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  } else {
    // In production, log errors but don't expose stack traces
    console.error('Error:', {
      message: err.message,
      path: req.path,
      method: req.method,
      status,
    });
  }

  // Don't expose internal error details to clients
  const message =
    status === 500
      ? 'Internal server error'
      : err.message || 'An error occurred';

  res.status(status).json({
    error: message,
    // Only include status code, not stack traces
    ...(isDevelopment && err.stack ? { stack: err.stack } : {}),
  });
});

module.exports = app;

