# Production Checklist & Best Practices

## Security Best Practices Implemented

### ✅ Authentication & Authorization
- [x] JWT tokens stored in httpOnly cookies (prevents XSS attacks)
- [x] Tokens never exposed in response body
- [x] Secure cookie flags (SameSite=None; Secure) for cross-site requests
- [x] Token expiration (15min access, 7day refresh)
- [x] Role-based access control (RBAC)

### ✅ Security Headers
- [x] Helmet.js configured for security headers
- [x] CORS properly configured with credentials
- [x] Trust proxy enabled for reverse proxy support
- [x] Request size limits (10MB) to prevent DoS

### ✅ Error Handling
- [x] Global error handler that doesn't expose stack traces in production
- [x] Proper error logging (detailed in dev, sanitized in prod)
- [x] Consistent error response format

### ✅ Logging
- [x] Conditional debug logging (only when DEBUG_COOKIES=true)
- [x] Production logging uses 'combined' format
- [x] Sensitive data not logged

### ✅ Code Quality
- [x] Environment-based configuration
- [x] Diagnostic endpoints protected (dev only)
- [x] Clean separation of concerns

## Environment Variables Required

```env
# Database
DB_HOST=your_db_host
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name
DB_PORT=3306

# JWT Secrets (MUST be strong, random strings)
JWT_ACCESS_SECRET=your_strong_random_secret_here
JWT_REFRESH_SECRET=your_strong_random_secret_here

# Optional
NODE_ENV=production
PORT=4000
ALLOWED_ORIGINS=https://marthms.netlify.app,http://localhost:3000
DEBUG_COOKIES=false  # Set to true only for debugging
```

## Pre-Deployment Checklist

### Security
- [ ] All environment variables set and secure
- [ ] JWT secrets are strong and unique (use `openssl rand -hex 32`)
- [ ] Database credentials are secure
- [ ] DEBUG_COOKIES is set to `false` in production
- [ ] CORS origins are correctly configured
- [ ] HTTPS is enabled on the server

### Performance
- [ ] Database connection pooling is configured
- [ ] Request size limits are appropriate
- [ ] Logging level is appropriate for production

### Monitoring
- [ ] Health check endpoint (`/health`) is accessible
- [ ] Error logging is configured
- [ ] Database connection errors are handled

## Post-Deployment Verification

1. **Test Authentication:**
   - Login works
   - Cookies are set correctly
   - Refresh token works
   - Logout clears cookies

2. **Test Security:**
   - CORS headers are correct
   - Security headers are present (check with securityheaders.com)
   - Tokens are not exposed in response body
   - Error messages don't expose sensitive info

3. **Test Performance:**
   - Health endpoint responds quickly
   - Database queries are optimized
   - No memory leaks

## Monitoring & Maintenance

### Regular Checks
- Monitor error logs for authentication failures
- Check database connection pool usage
- Review audit logs for suspicious activity
- Monitor API response times

### Security Updates
- Keep dependencies updated (`npm audit`)
- Rotate JWT secrets periodically
- Review and update CORS origins as needed
- Monitor for security advisories

## Troubleshooting

### Cookies Not Working
1. Check `DEBUG_COOKIES=true` in logs
2. Verify SameSite=None and Secure flags
3. Check browser cookie settings
4. Test with `/api/auth/diagnostics` endpoint

### Authentication Failures
1. Check JWT secrets are set correctly
2. Verify token expiration times
3. Check cookie settings in browser
4. Review backend logs for errors

### CORS Issues
1. Verify ALLOWED_ORIGINS includes frontend URL
2. Check credentials: true in CORS config
3. Verify preflight requests are handled

## Notes

- Diagnostic endpoint (`/api/auth/diagnostics`) is disabled in production unless `DEBUG_COOKIES=true`
- Debug logging is minimal in production to reduce log noise
- All sensitive operations are logged to audit_logs table
- Error responses are sanitized to prevent information leakage
