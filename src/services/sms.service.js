const axios = require('axios');

// UGSMS API Configuration
// Base URL: https://www.ugsms.com
// API v1 endpoint: /v1/sms/send
const UGSMS_BASE_URL = process.env.UGSMS_BASE_URL || 'https://www.ugsms.com';
const UGSMS_API_VERSION = process.env.UGSMS_API_VERSION || 'v1';
const UGSMS_USERNAME = process.env.UGSMS_USERNAME;
const UGSMS_PASSWORD = process.env.UGSMS_PASSWORD;
const UGSMS_SENDER_ID = process.env.UGSMS_SENDER_ID;

// Application branding for SMS messages
const APP_NAME = process.env.APP_NAME || 'Hostel Management System';

// Rate limiting: 60 requests per minute per user
// We'll track requests to prevent exceeding the limit
const rateLimitTracker = {
  requests: [],
  maxRequests: 60,
  windowMs: 60 * 1000, // 1 minute
};

function checkRateLimit() {
  const now = Date.now();
  // Remove requests older than 1 minute
  rateLimitTracker.requests = rateLimitTracker.requests.filter(
    (timestamp) => now - timestamp < rateLimitTracker.windowMs
  );
  
  if (rateLimitTracker.requests.length >= rateLimitTracker.maxRequests) {
    throw new Error('Rate limit exceeded. Maximum 60 requests per minute.');
  }
  
  // Add current request
  rateLimitTracker.requests.push(now);
}

/**
 * Format phone number to UGSMS format (07XXXXXXXX or +2567XXXXXXXX)
 * @param {string} phone - Phone number in any format
 * @returns {string} - Formatted phone number
 */
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '');
  
  // Convert to Ugandan format
  if (cleaned.startsWith('256')) {
    // Already in 256 format, convert to +256
    return `+${cleaned}`;
  } else if (cleaned.startsWith('0')) {
    // Already in 07 format
    return cleaned;
  } else if (cleaned.length === 9) {
    // Missing leading 0, add it
    return `0${cleaned}`;
  } else if (cleaned.length === 10 && cleaned.startsWith('7')) {
    // Missing leading 0
    return `0${cleaned}`;
  }
  
  return cleaned;
}

/**
 * Send SMS using UGSMS API
 * @param {string|string[]} numbers - Phone number(s) to send to
 * @param {string} message - SMS message content
 * @returns {Promise<Object>} - Response from UGSMS API
 */
async function sendSMS(numbers, message) {
  if (!UGSMS_USERNAME || !UGSMS_PASSWORD) {
    console.warn('UGSMS credentials not configured. SMS sending disabled.');
    // In development, log the message instead of sending
    if (process.env.NODE_ENV !== 'production') {
      console.log('📱 [DEV MODE] SMS would be sent:');
      console.log(`   To: ${Array.isArray(numbers) ? numbers.join(', ') : numbers}`);
      console.log(`   Message: ${message}`);
      return {
        success: true,
        message: 'SMS sent (dev mode)',
        data: {
          message_id: `dev-${Date.now()}`,
          recipients: Array.isArray(numbers) ? numbers.length : 1,
          estimated_cost: 0,
          remaining_balance: 0,
        },
      };
    }
    throw new Error('SMS service not configured');
  }

  // Format phone numbers
  const phoneNumbers = Array.isArray(numbers) 
    ? numbers.map(formatPhoneNumber).filter(Boolean)
    : [formatPhoneNumber(numbers)].filter(Boolean);

  if (phoneNumbers.length === 0) {
    throw new Error('No valid phone numbers provided');
  }

  const numbersString = phoneNumbers.join(',');

  // Check rate limit before making request
  try {
    checkRateLimit();
  } catch (rateLimitError) {
    console.warn('UGSMS Rate Limit Warning:', rateLimitError.message);
    throw new Error('Too many SMS requests. Please wait a moment and try again.');
  }

  // Validate sender ID is provided (required for production)
  if (!UGSMS_SENDER_ID && process.env.NODE_ENV === 'production') {
    throw new Error('UGSMS_SENDER_ID is required in production environment');
  }

  try {
    // Construct the full endpoint URL
    // Base URL: https://www.ugsms.com
    // API v1 endpoint: /v1/sms/send
    const endpoint = `${UGSMS_BASE_URL}/${UGSMS_API_VERSION}/sms/send`;
    
    const response = await axios.post(
      endpoint,
      {
        username: UGSMS_USERNAME,
        password: UGSMS_PASSWORD,
        numbers: numbersString,
        message_body: message,
        sender_id: UGSMS_SENDER_ID || 'HMS', // Fallback only for dev
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000, // 15 second timeout
      }
    );

    // UGSMS API Response Format:
    // Success: { success: true, message: "...", data: {...} }
    // Error: { error: "...", message: "..." }
    const responseData = response.data;

    if (responseData && responseData.success === true) {
      return responseData;
    } else if (responseData && responseData.error) {
      // API returned an error
      const errorMessage = responseData.message || responseData.error || 'Failed to send SMS';
      console.error('UGSMS API Error:', errorMessage, responseData);
      throw new Error(errorMessage);
    } else {
      // Unexpected response format
      console.error('UGSMS API: Unexpected response format', responseData);
      throw new Error('Failed to send SMS. Unexpected response from SMS service.');
    }
  } catch (error) {
    if (error.response) {
      // API returned an error response
      const errorData = error.response.data;
      
      // Check for rate limiting (429 status)
      if (error.response.status === 429) {
        throw new Error('Rate limit exceeded. Maximum 60 requests per minute. Please wait and try again.');
      }
      
      // Check for error field in response
      const errorMessage = errorData?.error || errorData?.message || `SMS API error: ${error.response.status}`;
      console.error('UGSMS API Error:', errorMessage, errorData);
      throw new Error(errorMessage);
    } else if (error.request) {
      // Request was made but no response received
      console.error('UGSMS API: No response received', error.message);
      throw new Error('SMS service unavailable. Please try again later.');
    } else {
      // Error setting up the request (including rate limit errors)
      if (error.message.includes('Rate limit')) {
        throw error; // Re-throw rate limit errors
      }
      console.error('UGSMS API: Request setup error', error.message);
      throw new Error('Failed to send SMS. Please try again later.');
    }
  }
}

/**
 * Send OTP via SMS
 * @param {string} phone - Phone number to send OTP to
 * @param {string} otp - 6-digit OTP code
 * @returns {Promise<Object>} - Response from SMS service
 */
async function sendOTP(phone, otp) {
  const otpMessage = process.env.OTP_MESSAGE_TEMPLATE || 
    `Your ${APP_NAME} password reset code is: {OTP}. Valid for 10 minutes. Do not share this code.`;
  const message = otpMessage.replace('{OTP}', otp);
  return sendSMS(phone, message);
}

module.exports = {
  sendSMS,
  sendOTP,
  formatPhoneNumber,
};
