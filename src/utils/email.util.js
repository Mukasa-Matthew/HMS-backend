const { sendEmail } = require('../services/email.service');
const { getDb } = require('../config/db');

/**
 * Create professional email HTML for student registration/allocation
 */
function createRegistrationEmailHTML(hostelName, studentName, roomNumber, amountPaid, amountLeft) {
  const paid = typeof amountPaid === 'number' ? amountPaid.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0';
  const left = typeof amountLeft === 'number' ? amountLeft.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '0';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to ${hostelName}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to ${hostelName}!</h1>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
        <p style="color: #1f2937; font-size: 16px;">Dear <strong>${studentName}</strong>,</p>
        <p style="color: #4b5563;">We are delighted to welcome you to <strong>${hostelName}</strong>!</p>
        
        <div style="background: #f9fafb; border-left: 4px solid #10b981; padding: 20px; margin: 20px 0; border-radius: 4px;">
          <h3 style="color: #1f2937; margin-top: 0;">Your Room Allocation Details:</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280;"><strong>Room Number:</strong></td>
              <td style="padding: 8px 0; color: #1f2937; text-align: right;"><strong>${roomNumber}</strong></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;"><strong>Amount Paid:</strong></td>
              <td style="padding: 8px 0; color: #10b981; text-align: right;"><strong>${paid} UGX</strong></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;"><strong>Balance:</strong></td>
              <td style="padding: 8px 0; color: #ef4444; text-align: right;"><strong>${left} UGX</strong></td>
            </tr>
          </table>
        </div>
        
        <p style="color: #4b5563;">We hope you have a comfortable and enjoyable stay with us. If you have any questions or need assistance, please don't hesitate to contact our support team.</p>
        
        <p style="color: #4b5563; margin-top: 30px;">Best regards,<br><strong>${hostelName} Management Team</strong></p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
        <p>©2026, a product of <strong>MARTMOR TECHNOLOGIES</strong></p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Create welcome check-in email HTML
 */
function createCheckInEmailHTML(hostelName, studentName) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to ${hostelName}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to ${hostelName}!</h1>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
        <p style="color: #1f2937; font-size: 16px;">Dear <strong>${studentName}</strong>,</p>
        <p style="color: #4b5563;">You have successfully checked in to <strong>${hostelName}</strong>!</p>
        <p style="color: #4b5563;">We hope you have a great stay with us. If you need any assistance, please don't hesitate to contact our support team.</p>
        <p style="color: #4b5563; margin-top: 30px;">Best regards,<br><strong>${hostelName} Management Team</strong></p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
        <p>©2026, a product of <strong>MARTMOR TECHNOLOGIES</strong></p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Create check-out email HTML
 */
function createCheckOutEmailHTML(hostelName, studentName) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Thank You - ${hostelName}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Thank You!</h1>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
        <p style="color: #1f2937; font-size: 16px;">Dear <strong>${studentName}</strong>,</p>
        <p style="color: #4b5563;">You have successfully checked out of <strong>${hostelName}</strong>.</p>
        <p style="color: #4b5563;">Thank you for staying with us! We hope you enjoyed your time and we look forward to welcoming you back in the future.</p>
        <p style="color: #4b5563; margin-top: 30px;">Safe travels!<br><strong>${hostelName} Management Team</strong></p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
        <p>©2026, a product of <strong>MARTMOR TECHNOLOGIES</strong></p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send email and save to history (replaces SMS history)
 * @param {Object} params - Email parameters
 * @param {number} params.studentId - Student ID
 * @param {string} params.email - Email address
 * @param {string} params.messageType - Type of message (REGISTRATION, CHECK_IN, CHECK_OUT)
 * @param {string} params.subject - Email subject
 * @param {string} params.html - HTML email content
 * @param {number} params.sentByUserId - User ID who triggered the email
 * @returns {Promise<Object>} - Result with success status and email history record
 */
async function sendEmailWithHistory({ studentId, email, messageType, subject, html, sentByUserId }) {
  const db = getDb();
  
  if (!email || !email.includes('@')) {
    return {
      success: false,
      error: 'Invalid email address',
      emailHistoryId: null,
    };
  }

  let emailHistoryId = null;
  let emailResult = null;
  let errorMessage = null;

  try {
    // Send email
    emailResult = await sendEmail({
      to: email,
      subject: subject,
      html: html,
    });
    
    // Save to history with success status (using sms_history table for now, we'll rename it later)
    const [result] = await db.execute(
      `INSERT INTO sms_history (student_id, phone, message_type, message_content, message_status, sent_by_user_id)
       VALUES (?, ?, ?, ?, 'sent', ?)`,
      [studentId, email, messageType, subject, sentByUserId]
    );
    emailHistoryId = result.insertId;

    return {
      success: true,
      emailHistoryId,
      messageId: emailResult?.messageId || null,
    };
  } catch (error) {
    errorMessage = error.message || 'Failed to send email';
    console.error(`Email sending failed for student ${studentId}:`, errorMessage);

    // Save to history with error status
    try {
      const [result] = await db.execute(
        `INSERT INTO sms_history (student_id, phone, message_type, message_content, message_status, error_message, sent_by_user_id)
         VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
        [studentId, email, messageType, subject, errorMessage, sentByUserId]
      );
      emailHistoryId = result.insertId;
    } catch (dbError) {
      console.error('Failed to save email history:', dbError);
    }

    return {
      success: false,
      error: errorMessage,
      emailHistoryId,
    };
  }
}

module.exports = {
  createRegistrationEmailHTML,
  createCheckInEmailHTML,
  createCheckOutEmailHTML,
  sendEmailWithHistory,
};
