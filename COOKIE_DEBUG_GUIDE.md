# Cookie Authentication Debugging Guide

## Quick Fix Steps

### 1. Enable Debug Logging
Add to your backend `.env` file:
```
DEBUG_COOKIES=true
```

### 2. Restart Backend
Restart your backend server to apply changes.

### 3. Test Diagnostic Endpoint
Visit in your browser:
```
https://hmsapi.martomor.xyz/api/auth/diagnostics
```

This will show you:
- What cookies are being received
- Cookie options being used
- Request headers
- Whether cookies are being set correctly

### 4. Check Browser Settings

**Chrome/Edge:**
1. Go to `chrome://settings/cookies` or `edge://settings/cookies`
2. Make sure "Allow all cookies" is enabled (or at least "Block third-party cookies in Incognito" is OFF)
3. For your specific site, add exception for `hmsapi.martomor.xyz`

**Firefox:**
1. Go to `about:preferences#privacy`
2. Under "Cookies and Site Data", make sure "Accept cookies and site data" is checked
3. Click "Exceptions" and add `hmsapi.martomor.xyz` with "Allow"

### 5. Clear Everything and Test Fresh

1. **Clear all cookies:**
   - DevTools → Application → Cookies
   - Delete ALL cookies for both `marthms.netlify.app` and `hmsapi.martomor.xyz`

2. **Clear browser cache:**
   - Hard refresh: `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac)

3. **Test login:**
   - Go to `https://marthms.netlify.app/login`
   - Log in
   - Check backend logs - you should see: `Cookies set for user [username] - SameSite: none, Secure: true`

4. **Check cookies in browser:**
   - DevTools → Application → Cookies → `https://hmsapi.martomor.xyz`
   - You should see `hms_access` and `hms_refresh` cookies
   - Both should have `SameSite: None` and `Secure: ✓` checked

5. **Check Network tab:**
   - DevTools → Network → Filter by "api"
   - Click on `/api/auth/login` → Response Headers → Look for `Set-Cookie` headers
   - Click on next request (e.g., `/api/users`) → Request Headers → Look for `Cookie: hms_access=...`

## What to Look For in Backend Logs

After enabling `DEBUG_COOKIES=true`, you should see:

**On Login:**
```
Setting cookies with options: { httpOnly: true, secure: true, sameSite: 'none', ... }
Cookies set for user [username] - SameSite: none, Secure: true
```

**On Subsequent Requests (if cookies are being sent):**
```
Incoming request cookies: { path: '/api/users', cookies: ['hms_access', 'hms_refresh'], ... }
```

**If cookies are NOT being sent:**
```
Auth failed - No token found: { hasCookies: false, cookieKeys: [], ... }
```

## Common Issues

### Issue: Cookies not appearing in browser
**Possible causes:**
- Browser blocking third-party cookies
- Backend not detecting HTTPS correctly
- Cookie domain/path issues

**Solution:**
1. Check diagnostic endpoint output
2. Verify browser cookie settings
3. Check backend logs for cookie options

### Issue: Cookies set but not sent
**Possible causes:**
- `SameSite=None` requires `Secure=true`
- Browser blocking cross-site cookies
- CORS not allowing credentials

**Solution:**
1. Verify `SameSite: none` and `Secure: ✓` in browser DevTools
2. Check CORS configuration allows credentials
3. Test with different browser

### Issue: Still getting 401 after login
**Check:**
1. Are cookies being set? (Check Response Headers on login)
2. Are cookies being sent? (Check Request Headers on next API call)
3. Are cookies visible in DevTools?
4. What do backend logs show?

## Fallback Solution

If cookies continue to fail, the backend now returns tokens in the login response. The frontend can use these as a fallback, but cookies are preferred for security.

## Still Not Working?

1. Share the output from `/api/auth/diagnostics`
2. Share relevant backend logs (with DEBUG_COOKIES=true)
3. Share a screenshot of:
   - DevTools → Application → Cookies → `hmsapi.martomor.xyz`
   - DevTools → Network → Login request → Response Headers
   - DevTools → Network → Next API request → Request Headers
