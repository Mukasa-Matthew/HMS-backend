const { getDb } = require('../config/db');
const { isCustodianPriceMarkupEnabled } = require('./feature-settings.util');

/**
 * Create professional receipt HTML template
 */
function createReceiptHTML({
  receiptNumber,
  hostelName,
  hostelContactPhone,
  studentName,
  registrationNumber,
  studentPhone,
  roomNumber,
  amountPaid,
  totalRequired,
  balance,
  paymentDate,
  paymentId,
}) {
  const formattedAmountPaid = typeof amountPaid === 'number' 
    ? amountPaid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
    : '0.00';
  const formattedTotalRequired = typeof totalRequired === 'number' 
    ? totalRequired.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
    : '0.00';
  const formattedBalance = typeof balance === 'number' 
    ? balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) 
    : '0.00';
  
  const paymentDateFormatted = paymentDate 
    ? new Date(paymentDate).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : new Date().toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Receipt - ${receiptNumber}</title>
      <style>
        @media print {
          body { margin: 0; padding: 0; }
          .no-print { display: none !important; }
        }
      </style>
    </head>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: #f5f5f5;">
      <div style="max-width: 800px; margin: 0 auto; background: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-radius: 12px; overflow: hidden;">
        <!-- Header with gradient -->
        <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 40px 30px; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 1px;">PAYMENT RECEIPT</h1>
          <p style="margin: 10px 0 0 0; font-size: 18px; opacity: 0.95;">${hostelName}</p>
        </div>

        <!-- Receipt Number Badge -->
        <div style="background: #f8fafc; padding: 20px 30px; border-bottom: 2px solid #e5e7eb;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <p style="margin: 0; color: #6b7280; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Receipt Number</p>
              <p style="margin: 5px 0 0 0; color: #1f2937; font-size: 24px; font-weight: 700;">#${receiptNumber}</p>
            </div>
            <div style="text-align: right;">
              <p style="margin: 0; color: #6b7280; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Date</p>
              <p style="margin: 5px 0 0 0; color: #1f2937; font-size: 16px; font-weight: 600;">${paymentDateFormatted}</p>
            </div>
          </div>
        </div>

        <!-- Student Information -->
        <div style="padding: 30px; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 20px; font-weight: 700; border-bottom: 3px solid #6366f1; padding-bottom: 10px;">Student Information</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 12px 0; color: #6b7280; font-size: 15px; font-weight: 600; width: 40%;">Student Name:</td>
              <td style="padding: 12px 0; color: #1f2937; font-size: 15px; font-weight: 600;">${studentName}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #6b7280; font-size: 15px; font-weight: 600;">Registration Number:</td>
              <td style="padding: 12px 0; color: #1f2937; font-size: 15px; font-weight: 600;">${registrationNumber}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #6b7280; font-size: 15px; font-weight: 600;">Phone Number:</td>
              <td style="padding: 12px 0; color: #1f2937; font-size: 15px; font-weight: 600;">${studentPhone || 'N/A'}</td>
            </tr>
            <tr>
              <td style="padding: 12px 0; color: #6b7280; font-size: 15px; font-weight: 600;">Room Number:</td>
              <td style="padding: 12px 0; color: #6366f1; font-size: 15px; font-weight: 700;">${roomNumber || 'N/A'}</td>
            </tr>
          </table>
        </div>

        <!-- Payment Details -->
        <div style="padding: 30px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;">
          <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 20px; font-weight: 700; border-bottom: 3px solid #10b981; padding-bottom: 10px;">Payment Details</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr style="background: white; border-radius: 8px;">
              <td style="padding: 15px; color: #6b7280; font-size: 15px; font-weight: 600;">Total Required:</td>
              <td style="padding: 15px; color: #1f2937; font-size: 16px; font-weight: 700; text-align: right;">UGX ${formattedTotalRequired}</td>
            </tr>
            <tr style="background: white; border-radius: 8px;">
              <td style="padding: 15px; color: #6b7280; font-size: 15px; font-weight: 600;">Amount Paid:</td>
              <td style="padding: 15px; color: #10b981; font-size: 18px; font-weight: 700; text-align: right;">UGX ${formattedAmountPaid}</td>
            </tr>
            <tr style="background: ${balance > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: 8px; border-top: 2px solid ${balance > 0 ? '#fecaca' : '#bbf7d0'};">
              <td style="padding: 15px; color: #1f2937; font-size: 16px; font-weight: 700;">Balance:</td>
              <td style="padding: 15px; color: ${balance > 0 ? '#dc2626' : '#16a34a'}; font-size: 18px; font-weight: 700; text-align: right;">UGX ${formattedBalance}</td>
            </tr>
          </table>
        </div>

        <!-- Contact Information -->
        <div style="padding: 30px; background: #fef3c7; border-top: 3px solid #f59e0b;">
          <h3 style="margin: 0 0 15px 0; color: #92400e; font-size: 16px; font-weight: 700;">For Inquiries</h3>
          <p style="margin: 0; color: #78350f; font-size: 15px; line-height: 1.8;">
            <strong>Hostel Contact:</strong> ${hostelContactPhone || 'N/A'}<br>
            Please contact us if you have any questions regarding this receipt.
          </p>
        </div>

        <!-- Footer -->
        <div style="background: #1f2937; padding: 20px 30px; text-align: center; color: #9ca3af; font-size: 12px;">
          <p style="margin: 0;">This is an official receipt from ${hostelName}</p>
          <p style="margin: 5px 0 0 0;">Generated on ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Create summarized SMS receipt (fits SMS character limit)
 */
function createSMSReceipt({
  receiptNumber,
  hostelName,
  studentName,
  roomNumber,
  amountPaid,
  balance,
  paymentDate,
}) {
  const formattedAmountPaid = typeof amountPaid === 'number' 
    ? amountPaid.toLocaleString('en-US', { maximumFractionDigits: 0 }) 
    : '0';
  const formattedBalance = typeof balance === 'number' 
    ? balance.toLocaleString('en-US', { maximumFractionDigits: 0 }) 
    : '0';
  
  const date = paymentDate 
    ? new Date(paymentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return `RECEIPT #${receiptNumber}\n${hostelName}\n${studentName} - ${roomNumber || 'N/A'}\nPaid: UGX ${formattedAmountPaid}\nBalance: UGX ${formattedBalance}\nDate: ${date}\nThank you!`;
}

/**
 * Get receipt data for a payment
 */
async function getReceiptData(paymentId, userRole = null, hostelId = null) {
  const db = getDb();
  
  // Get payment with allocation and student details
  const [paymentRows] = await db.execute(
    `SELECT 
      p.id AS payment_id,
      p.amount,
      p.recorded_at,
      a.id AS allocation_id,
      a.room_price_at_allocation,
      a.display_price_at_allocation,
      a.room_id,
      s.id AS student_id,
      s.full_name,
      s.registration_number,
      s.phone AS student_phone,
      s.email,
      r.name AS room_name,
      h.name AS hostel_name,
      h.contact_phone AS hostel_contact_phone
    FROM payments p
    JOIN allocations a ON p.allocation_id = a.id
    JOIN students s ON a.student_id = s.id
    JOIN rooms r ON a.room_id = r.id
    JOIN hostels h ON a.hostel_id = h.id
    WHERE p.id = ?
    LIMIT 1`,
    [paymentId]
  );

  if (paymentRows.length === 0) {
    throw new Error('Payment not found');
  }

  const payment = paymentRows[0];
  
  // Get total paid for this allocation
  const [totalPaidRows] = await db.execute(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE allocation_id = ?',
    [payment.allocation_id]
  );
  const totalPaid = Number(totalPaidRows[0].total_paid || 0);

  // Receipts are always for students, so always use display amounts if available
  // (regardless of who is viewing the receipt - it's the student's receipt)
  let displayPriceToUse = payment.display_price_at_allocation 
    ? Number(payment.display_price_at_allocation) 
    : null;
  
  // Check if markup is enabled
  const markupEnabled = await isCustodianPriceMarkupEnabled(payment.hostel_id);
  
  // Calculate receipt amounts
  let receiptTotalRequired = Number(payment.room_price_at_allocation || 0);
  let receiptAmountPaid = totalPaid;
  let receiptBalance = receiptTotalRequired - receiptAmountPaid;
  
  // If display price exists and markup is enabled, use display amounts for receipt
  if (displayPriceToUse !== null && markupEnabled) {
    const markupRatio = displayPriceToUse / Number(payment.room_price_at_allocation);
    receiptAmountPaid = totalPaid * markupRatio;
    receiptTotalRequired = displayPriceToUse;
    receiptBalance = receiptTotalRequired - receiptAmountPaid;
  }

  return {
    receiptNumber: `RCP-${payment.payment_id.toString().padStart(6, '0')}`,
    hostelName: payment.hostel_name,
    hostelContactPhone: payment.hostel_contact_phone,
    studentName: payment.full_name,
    registrationNumber: payment.registration_number,
    studentPhone: payment.student_phone,
    roomNumber: payment.room_name,
    amountPaid: receiptAmountPaid,
    totalRequired: receiptTotalRequired,
    balance: receiptBalance,
    paymentDate: payment.recorded_at,
    paymentId: payment.payment_id,
  };
}

module.exports = {
  createReceiptHTML,
  createSMSReceipt,
  getReceiptData,
};
