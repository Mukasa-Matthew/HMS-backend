const nodemailer = require('nodemailer');

// Brevo (formerly Sendinblue) SMTP Configuration
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true';
const BREVO_SMTP_HOST = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
const BREVO_SMTP_PORT = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
const BREVO_SMTP_USER = process.env.BREVO_SMTP_USER;
const BREVO_SMTP_LOGIN = process.env.BREVO_SMTP_LOGIN;
const BREVO_SMTP_KEY = process.env.BREVO_SMTP_KEY;
const EMAIL_SENDER_OTP = process.env.EMAIL_SENDER_OTP || 'otp@martomor.xyz';
const EMAIL_SENDER_SUPPORT = process.env.EMAIL_SENDER_SUPPORT || 'support@martomor.xyz';

// Application branding for email messages
const APP_NAME = process.env.APP_NAME || 'Hostel Management System';

// Create reusable transporter
let transporter = null;

/**
 * Initialize email transporter
 */
function initEmailTransporter() {
  if (!EMAIL_ENABLED) {
    console.warn('Email service is disabled. Set EMAIL_ENABLED=true to enable.');
    return null;
  }

  if (!BREVO_SMTP_USER || !BREVO_SMTP_KEY) {
    console.warn('Brevo SMTP credentials not configured. Email sending disabled.');
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host: BREVO_SMTP_HOST,
      port: BREVO_SMTP_PORT,
      secure: BREVO_SMTP_PORT === 465, // true for 465, false for other ports
      auth: {
        user: BREVO_SMTP_USER || BREVO_SMTP_LOGIN,
        pass: BREVO_SMTP_KEY,
      },
      // Brevo requires TLS
      tls: {
        rejectUnauthorized: false, // For development, set to true in production with proper certs
      },
    });

    console.log('Email transporter initialized successfully');
    return transporter;
  } catch (error) {
    console.error('Failed to initialize email transporter:', error);
    return null;
  }
}

// Initialize on module load
if (EMAIL_ENABLED) {
  initEmailTransporter();
}

/**
 * Send email using Brevo SMTP
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @param {string} options.text - Plain text email body (optional)
 * @param {string} options.from - Sender email (defaults to support@martomor.xyz)
 * @returns {Promise<Object>} - Response with success status and message ID
 */
async function sendEmail({ to, subject, html, text, from = EMAIL_SENDER_SUPPORT }) {
  if (!EMAIL_ENABLED) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('📧 [DEV MODE] Email would be sent:');
      console.log(`   To: ${Array.isArray(to) ? to.join(', ') : to}`);
      console.log(`   From: ${from}`);
      console.log(`   Subject: ${subject}`);
      return {
        success: true,
        message: 'Email sent (dev mode)',
        messageId: `dev-${Date.now()}`,
      };
    }
    throw new Error('Email service is disabled');
  }

  if (!transporter) {
    // Try to initialize if not already done
    if (!initEmailTransporter()) {
      throw new Error('Email service not configured');
    }
  }

  // Ensure 'to' is an array
  const recipients = Array.isArray(to) ? to : [to];
  
  // Validate email addresses
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validRecipients = recipients.filter(email => emailRegex.test(email));
  
  if (validRecipients.length === 0) {
    throw new Error('No valid email addresses provided');
  }

  try {
    const mailOptions = {
      from: `"${APP_NAME}" <${from}>`, // Format: "Name" <email@domain.com>
      to: validRecipients.join(', '),
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version
    };

    const info = await transporter.sendMail(mailOptions);
    
    return {
      success: true,
      message: 'Email sent successfully',
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
    };
  } catch (error) {
    console.error('Email sending failed:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send OTP via Email
 * @param {string} email - Email address to send OTP to
 * @param {string} otp - 6-digit OTP code
 * @returns {Promise<Object>} - Response from email service
 */
async function sendOTP(email, otp) {
  const subject = `${APP_NAME} - Password Reset Code`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Password Reset Code</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${APP_NAME}</h1>
      </div>
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
        <h2 style="color: #1f2937; margin-top: 0;">Password Reset Code</h2>
        <p style="color: #4b5563;">Your password reset code is:</p>
        <div style="background: #f3f4f6; border: 2px dashed #10b981; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; color: #10b981; letter-spacing: 8px;">${otp}</span>
        </div>
        <p style="color: #4b5563;">This code is valid for <strong>10 minutes</strong>. Please do not share this code with anyone.</p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
          If you did not request this password reset, please ignore this email or contact support if you have concerns.
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
        <p>©2026, a product of <strong>MARTMOR TECHNOLOGIES</strong></p>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    to: email,
    subject: subject,
    html: html,
    from: EMAIL_SENDER_OTP,
  });
}

module.exports = {
  sendEmail,
  sendOTP,
  initEmailTransporter,
};
