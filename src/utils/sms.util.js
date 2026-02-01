const { sendSMS, formatPhoneNumber } = require('../services/sms.service');
const { getDb } = require('../config/db');

/**
 * Create professional SMS message for student registration/allocation
 * Must be under 160 characters (GSM encoding)
 */
function createRegistrationMessage(hostelName, studentName, roomNumber, amountPaid, amountLeft) {
  const hostel = hostelName.length > 20 ? hostelName.substring(0, 17) + '...' : hostelName;
  const name = studentName.length > 30 ? studentName.substring(0, 27) + '...' : studentName;
  
  const paid = typeof amountPaid === 'number' ? amountPaid.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0';
  const left = typeof amountLeft === 'number' ? amountLeft.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0';
  
  // Professional format
  let message = `Dear ${name}, Welcome to ${hostel}! Room: ${roomNumber}, Amount Paid: ${paid} UGX, Balance: ${left} UGX. Thank you!`;
  
  // If too long, try shorter version
  if (message.length > 160) {
    message = `Dear ${name}, Welcome to ${hostel}! Room: ${roomNumber}, Paid: ${paid} UGX, Balance: ${left} UGX. Thank you!`;
  }
  
  // If still too long, truncate name
  if (message.length > 160) {
    const nameLen = name.length;
    const availableSpace = 160 - (message.length - nameLen);
    const truncatedName = name.substring(0, Math.max(15, availableSpace - 3)) + (name.length > availableSpace ? '...' : '');
    message = `Dear ${truncatedName}, Welcome to ${hostel}! Room: ${roomNumber}, Paid: ${paid} UGX, Balance: ${left} UGX. Thank you!`;
  }
  
  // If still too long, shorten hostel name
  if (message.length > 160) {
    const shortHostel = hostel.length > 15 ? hostel.substring(0, 12) + '...' : hostel;
    const nameLen = name.length;
    const availableSpace = 160 - (message.length - nameLen - (hostel.length - shortHostel.length));
    const truncatedName = name.substring(0, Math.max(15, availableSpace - 3)) + (name.length > availableSpace ? '...' : '');
    message = `Dear ${truncatedName}, Welcome to ${shortHostel}! Room: ${roomNumber}, Paid: ${paid} UGX, Balance: ${left} UGX. Thank you!`;
  }
  
  return message.substring(0, 160); // Ensure max 160 chars
}

/**
 * Create welcome check-in message
 * Must be under 160 characters
 */
function createCheckInMessage(hostelName, studentName) {
  const hostel = hostelName.length > 20 ? hostelName.substring(0, 17) + '...' : hostelName;
  const name = studentName.length > 25 ? studentName.substring(0, 22) + '...' : studentName;
  
  let message = `Welcome to ${hostel}! ${name}, you're checked in. Have a great stay!`;
  
  if (message.length > 160) {
    // Shorter version
    message = `Welcome ${name}! Checked in at ${hostel}. Have a great stay!`;
  }
  
  if (message.length > 160) {
    // Even shorter
    const shortHostel = hostel.length > 15 ? hostel.substring(0, 12) + '...' : hostel;
    const shortName = name.length > 20 ? name.substring(0, 17) + '...' : name;
    message = `Welcome ${shortName}! Checked in at ${shortHostel}.`;
  }
  
  return message.substring(0, 160);
}

/**
 * Create check-out message
 * Must be under 160 characters
 */
function createCheckOutMessage(hostelName, studentName) {
  const hostel = hostelName.length > 20 ? hostelName.substring(0, 17) + '...' : hostelName;
  const name = studentName.length > 25 ? studentName.substring(0, 22) + '...' : studentName;
  
  let message = `Thank you ${name}! You've checked out of ${hostel}. We hope you enjoyed your stay!`;
  
  if (message.length > 160) {
    // Shorter version
    message = `Thank you ${name}! Checked out of ${hostel}. Safe travels!`;
  }
  
  if (message.length > 160) {
    // Even shorter
    const shortHostel = hostel.length > 15 ? hostel.substring(0, 12) + '...' : hostel;
    const shortName = name.length > 20 ? name.substring(0, 17) + '...' : name;
    message = `Thank you ${shortName}! Checked out of ${shortHostel}. Safe travels!`;
  }
  
  return message.substring(0, 160);
}

/**
 * Send SMS and save to history
 * @param {Object} params - SMS parameters
 * @param {number} params.studentId - Student ID
 * @param {string} params.phone - Phone number
 * @param {string} params.messageType - Type of message (REGISTRATION, CHECK_IN, CHECK_OUT)
 * @param {string} params.message - Message content
 * @param {number} params.sentByUserId - User ID who triggered the SMS
 * @returns {Promise<Object>} - Result with success status and SMS history record
 */
async function sendSMSWithHistory({ studentId, phone, messageType, message, sentByUserId }) {
  const db = getDb();
  const formattedPhone = formatPhoneNumber(phone);
  
  if (!formattedPhone) {
    return {
      success: false,
      error: 'Invalid phone number format',
      smsHistoryId: null,
    };
  }

  let smsHistoryId = null;
  let smsResult = null;
  let errorMessage = null;

  try {
    // Send SMS
    smsResult = await sendSMS(formattedPhone, message);
    
    // Save to history with success status
    const [result] = await db.execute(
      `INSERT INTO sms_history (student_id, phone, message_type, message_content, message_status, sent_by_user_id)
       VALUES (?, ?, ?, ?, 'sent', ?)`,
      [studentId, formattedPhone, messageType, message, sentByUserId]
    );
    smsHistoryId = result.insertId;

    return {
      success: true,
      smsHistoryId,
      messageId: smsResult?.data?.message_id || null,
    };
  } catch (error) {
    errorMessage = error.message || 'Failed to send SMS';
    console.error(`SMS sending failed for student ${studentId}:`, errorMessage);

    // Save to history with error status
    try {
      const [result] = await db.execute(
        `INSERT INTO sms_history (student_id, phone, message_type, message_content, message_status, error_message, sent_by_user_id)
         VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
        [studentId, formattedPhone, messageType, message, errorMessage, sentByUserId]
      );
      smsHistoryId = result.insertId;
    } catch (dbError) {
      console.error('Failed to save SMS history:', dbError);
    }

    return {
      success: false,
      error: errorMessage,
      smsHistoryId,
    };
  }
}

module.exports = {
  createRegistrationMessage,
  createCheckInMessage,
  createCheckOutMessage,
  sendSMSWithHistory,
};
