const { hashPassword } = require('../utils/password.util');

async function runMigrations(pool) {
  async function columnExists(tableName, columnName) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [tableName, columnName],
    );
    return Number(rows[0]?.cnt || 0) > 0;
  }

  async function addColumnIfMissing(tableName, columnSql, columnName) {
    const exists = await columnExists(tableName, columnName);
    if (!exists) {
      await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnSql}`);
    }
  }

  // Core schema - CREATE TABLE IF NOT EXISTS so backend can start on a fresh DB
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hostels (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      location VARCHAR(255),
      contact_phone VARCHAR(30),
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL UNIQUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL UNIQUE,
      phone VARCHAR(20),
      password_hash VARCHAR(255) NOT NULL,
      role_id INT NOT NULL,
      hostel_id INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES roles(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10, 2) NOT NULL,
      capacity INT NOT NULL,
      hostel_id INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hostel_id INT NULL,
      full_name VARCHAR(150) NOT NULL,
      registration_number VARCHAR(50) NOT NULL,
      phone VARCHAR(20),
      email VARCHAR(100),
      access_number VARCHAR(50),
      address VARCHAR(255),
      emergency_contact VARCHAR(100),
      gender ENUM('male', 'female') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add missing columns if they don't exist
  await addColumnIfMissing('students', 'access_number VARCHAR(50)', 'access_number');
  await addColumnIfMissing('students', 'address VARCHAR(255)', 'address');
  await addColumnIfMissing('students', 'emergency_contact VARCHAR(100)', 'emergency_contact');
  await addColumnIfMissing('students', "gender ENUM('male', 'female') NOT NULL DEFAULT 'male'", 'gender');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS allocations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hostel_id INT NULL,
      student_id INT NOT NULL,
      room_id INT NOT NULL,
      room_price_at_allocation DECIMAL(10, 2) NOT NULL,
      allocated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id INT PRIMARY KEY AUTO_INCREMENT,
      allocation_id INT NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      recorded_by_user_id INT NOT NULL,
      recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (allocation_id) REFERENCES allocations(id),
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      actor_user_id INT NULL,
      actor_role VARCHAR(50),
      actor_hostel_id INT NULL,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(80),
      entity_id INT NULL,
      details JSON NULL,
      ip_address VARCHAR(45),
      user_agent VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create semesters table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS semesters (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hostel_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (hostel_id) REFERENCES hostels(id),
      INDEX idx_hostel_active (hostel_id, is_active)
    )
  `);

  // Fix: Drop the old constraint if it exists (it prevents multiple inactive semesters)
  // We'll enforce "only one active semester" in application code instead
  try {
    const [indexExists] = await pool.query(`
      SELECT COUNT(*) as cnt 
      FROM INFORMATION_SCHEMA.STATISTICS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'semesters' 
      AND INDEX_NAME = 'unique_active_semester'
    `);
    if (indexExists[0].cnt > 0) {
      await pool.query(`ALTER TABLE semesters DROP INDEX unique_active_semester`);
      console.log('Dropped old unique_active_semester constraint to allow multiple inactive semesters');
    }
  } catch (err) {
    // Index doesn't exist or already dropped, that's fine
    if (!err.message.includes("Unknown key") && !err.message.includes("check that it exists")) {
      console.warn('Could not drop unique_active_semester constraint:', err.message);
    }
  }

  // Seed roles (idempotent)
  await pool.query(`
    INSERT INTO roles (name) VALUES
      ('SUPER_ADMIN'),
      ('CUSTODIAN'),
      ('HOSTEL_OWNER')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  // Seed Super Admin from environment variables (idempotent)
  const superAdminUsername = process.env.SUPER_ADMIN_USERNAME;
  const superAdminPhone = process.env.SUPER_ADMIN_PHONE || null;
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;

  if (superAdminUsername && superAdminPassword) {
    // Check if a super admin with this username already exists
    const [existing] = await pool.query(
      'SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = ? AND r.name = ? LIMIT 1',
      [superAdminUsername, 'SUPER_ADMIN'],
    );

    if (existing.length === 0) {
      const passwordHash = await hashPassword(superAdminPassword);

      const [roleRows] = await pool.query(
        'SELECT id FROM roles WHERE name = ? LIMIT 1',
        ['SUPER_ADMIN'],
      );

      if (roleRows.length > 0) {
        const roleId = roleRows[0].id;
        await pool.query(
          'INSERT INTO users (username, phone, password_hash, role_id, hostel_id, is_active) VALUES (?, ?, ?, ?, NULL, 1)',
          [superAdminUsername, superAdminPhone, passwordHash, roleId],
        );
      }
    }
  }

  // Ensure hostel_id columns exist when upgrading older DBs (without adding FKs to avoid migration failures)
  await addColumnIfMissing('users', 'hostel_id INT NULL', 'hostel_id');
  await addColumnIfMissing('rooms', 'hostel_id INT NULL', 'hostel_id');
  await addColumnIfMissing('students', 'hostel_id INT NULL', 'hostel_id');
  await addColumnIfMissing('allocations', 'hostel_id INT NULL', 'hostel_id');

  // Add semester_id columns to students, allocations, and payments
  await addColumnIfMissing('students', 'semester_id INT NULL', 'semester_id');
  await addColumnIfMissing('allocations', 'semester_id INT NULL', 'semester_id');
  await addColumnIfMissing('payments', 'semester_id INT NULL', 'semester_id');
  
  // Migrate registration_number constraint: Remove global unique, add semester-scoped unique
  // This allows the same registration number in different semesters
  try {
    // Find all unique indexes on registration_number (could have various names)
    const [uniqueIndexes] = await pool.query(`
      SELECT DISTINCT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'students'
      AND COLUMN_NAME = 'registration_number'
      AND NON_UNIQUE = 0
      AND INDEX_NAME != 'idx_students_reg_semester'
    `);
    
    // Drop all old unique constraints on registration_number
    for (const index of uniqueIndexes) {
      try {
        await pool.query(`ALTER TABLE students DROP INDEX \`${index.INDEX_NAME}\``);
        console.log(`Dropped old unique constraint ${index.INDEX_NAME} on registration_number`);
      } catch (dropErr) {
        console.warn(`Could not drop index ${index.INDEX_NAME}:`, dropErr.message);
      }
    }
    
    if (uniqueIndexes.length > 0) {
      console.log('Removed global unique constraint on registration_number to allow same number across semesters');
    }
  } catch (err) {
    console.warn('Could not check/drop old registration_number unique constraint:', err.message);
  }
  
  // Add composite unique index: (registration_number, semester_id)
  // This prevents duplicate registration numbers within the same semester
  // but allows the same number in different semesters
  try {
    // Check if the composite unique index already exists
    const [indexExists] = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'students'
      AND INDEX_NAME = 'idx_students_reg_semester'
    `);
    
    if (indexExists[0].cnt === 0) {
      await pool.query(`
        CREATE UNIQUE INDEX idx_students_reg_semester 
        ON students(registration_number, semester_id)
      `);
      console.log('Created composite unique index on (registration_number, semester_id)');
    } else {
      console.log('Composite unique index on (registration_number, semester_id) already exists');
    }
  } catch (err) {
    if (!err.message.includes('Duplicate key name') && !err.message.includes('already exists')) {
      console.warn('Could not create composite unique index:', err.message);
    }
  }
  
  // Add indexes for better query performance
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_students_semester ON students(semester_id)
  `).catch(() => {}); // Ignore if index already exists
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_allocations_semester ON allocations(semester_id)
  `).catch(() => {});
  
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_semester ON payments(semester_id)
  `).catch(() => {});

  // Create check_ins table for tracking student check-in/check-out
  await pool.query(`
    CREATE TABLE IF NOT EXISTS check_ins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      student_id INT NOT NULL,
      hostel_id INT NOT NULL,
      semester_id INT NOT NULL,
      checked_in_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checked_out_at TIMESTAMP NULL,
      checked_in_by_user_id INT NOT NULL,
      checked_out_by_user_id INT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (hostel_id) REFERENCES hostels(id),
      FOREIGN KEY (semester_id) REFERENCES semesters(id),
      FOREIGN KEY (checked_in_by_user_id) REFERENCES users(id),
      FOREIGN KEY (checked_out_by_user_id) REFERENCES users(id),
      INDEX idx_student_semester (student_id, semester_id),
      INDEX idx_hostel_semester (hostel_id, semester_id)
    )
  `);

  // Create expenses table for tracking hostel expenses
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hostel_id INT NOT NULL,
      semester_id INT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      description VARCHAR(500) NOT NULL,
      category VARCHAR(100),
      recorded_by_user_id INT NOT NULL,
      expense_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (hostel_id) REFERENCES hostels(id),
      FOREIGN KEY (semester_id) REFERENCES semesters(id),
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id),
      INDEX idx_hostel_semester (hostel_id, semester_id),
      INDEX idx_expense_date (expense_date),
      INDEX idx_recorded_by (recorded_by_user_id)
    )
  `);
  console.log('Created expenses table for tracking hostel expenses');

  // Ensure is_active exists on older DBs created before we added soft-disable support
  await addColumnIfMissing(
    'hostels',
    'is_active TINYINT(1) NOT NULL DEFAULT 1',
    'is_active',
  );

  // Create hostel_feature_settings table for feature visibility control
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hostel_feature_settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      hostel_id INT NOT NULL,
      feature_name VARCHAR(50) NOT NULL,
      enabled_for_owner TINYINT(1) NOT NULL DEFAULT 1,
      enabled_for_custodian TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (hostel_id) REFERENCES hostels(id) ON DELETE CASCADE,
      UNIQUE KEY unique_hostel_feature (hostel_id, feature_name),
      INDEX idx_hostel_id (hostel_id)
    )
  `);

  console.log('Created hostel_feature_settings table for feature visibility control');

  // ============================================
  // PERFORMANCE INDEXES - Add indexes for frequently queried columns
  // ============================================
  
  console.log('Adding performance indexes...');

  // Helper function to create index if it doesn't exist
  async function createIndexIfNotExists(tableName, indexName, columns) {
    try {
      const [indexExists] = await pool.query(`
        SELECT COUNT(*) as cnt
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      `, [tableName, indexName]);
      
      if (indexExists[0].cnt === 0) {
        await pool.query(`CREATE INDEX \`${indexName}\` ON \`${tableName}\`(${columns})`);
        return true;
      }
      return false;
    } catch (err) {
      if (!err.message.includes('Duplicate key name') && !err.message.includes('already exists')) {
        console.warn(`Could not create index ${indexName} on ${tableName}:`, err.message);
      }
      return false;
    }
  }

  // Users table indexes
  await createIndexIfNotExists('users', 'idx_users_hostel_id', 'hostel_id');
  await createIndexIfNotExists('users', 'idx_users_role_id', 'role_id');
  await createIndexIfNotExists('users', 'idx_users_is_active', 'is_active');
  await createIndexIfNotExists('users', 'idx_users_hostel_active', 'hostel_id, is_active');
  console.log('Added indexes on users table');

  // Rooms table indexes
  await createIndexIfNotExists('rooms', 'idx_rooms_hostel_id', 'hostel_id');
  await createIndexIfNotExists('rooms', 'idx_rooms_is_active', 'is_active');
  await createIndexIfNotExists('rooms', 'idx_rooms_hostel_active', 'hostel_id, is_active');
  console.log('Added indexes on rooms table');

  // Students table indexes
  await createIndexIfNotExists('students', 'idx_students_hostel_id', 'hostel_id');
  await createIndexIfNotExists('students', 'idx_students_hostel_semester', 'hostel_id, semester_id');
  console.log('Added indexes on students table');

  // Allocations table indexes
  await createIndexIfNotExists('allocations', 'idx_allocations_hostel_id', 'hostel_id');
  await createIndexIfNotExists('allocations', 'idx_allocations_student_id', 'student_id');
  await createIndexIfNotExists('allocations', 'idx_allocations_room_id', 'room_id');
  await createIndexIfNotExists('allocations', 'idx_allocations_hostel_semester', 'hostel_id, semester_id');
  await createIndexIfNotExists('allocations', 'idx_allocations_student_semester', 'student_id, semester_id');
  await createIndexIfNotExists('allocations', 'idx_allocations_allocated_at', 'allocated_at');
  console.log('Added indexes on allocations table');

  // Payments table indexes
  await createIndexIfNotExists('payments', 'idx_payments_allocation_id', 'allocation_id');
  await createIndexIfNotExists('payments', 'idx_payments_recorded_at', 'recorded_at');
  await createIndexIfNotExists('payments', 'idx_payments_hostel_semester', 'hostel_id, semester_id');
  await createIndexIfNotExists('payments', 'idx_payments_allocation_recorded', 'allocation_id, recorded_at');
  console.log('Added indexes on payments table');

  // Check-ins table indexes (some already exist, but adding missing ones)
  await createIndexIfNotExists('check_ins', 'idx_check_ins_checked_in_at', 'checked_in_at');
  await createIndexIfNotExists('check_ins', 'idx_check_ins_checked_out_at', 'checked_out_at');
  await createIndexIfNotExists('check_ins', 'idx_check_ins_student_semester_out', 'student_id, semester_id, checked_out_at');
  console.log('Added indexes on check_ins table');

  // Audit logs table indexes
  await createIndexIfNotExists('audit_logs', 'idx_audit_logs_actor_user_id', 'actor_user_id');
  await createIndexIfNotExists('audit_logs', 'idx_audit_logs_actor_hostel_id', 'actor_hostel_id');
  await createIndexIfNotExists('audit_logs', 'idx_audit_logs_created_at', 'created_at');
  await createIndexIfNotExists('audit_logs', 'idx_audit_logs_hostel_created', 'actor_hostel_id, created_at');
  console.log('Added indexes on audit_logs table');

  // Semesters table - ensure all necessary indexes exist
  await createIndexIfNotExists('semesters', 'idx_semesters_hostel_id', 'hostel_id');
  await createIndexIfNotExists('semesters', 'idx_semesters_is_active', 'is_active');
  await createIndexIfNotExists('semesters', 'idx_semesters_start_date', 'start_date');
  console.log('Added indexes on semesters table');

  // Expenses table - ensure all necessary indexes exist (some already exist)
  await createIndexIfNotExists('expenses', 'idx_expenses_category', 'category');
  await createIndexIfNotExists('expenses', 'idx_expenses_hostel_date', 'hostel_id, expense_date');
  console.log('Added indexes on expenses table');

  // Add hostel_id to payments if it doesn't exist (for better query performance)
  try {
    const [hasHostelId] = await pool.query(`
      SELECT COUNT(*) as cnt
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'hostel_id'
    `);
    
    if (hasHostelId[0].cnt === 0) {
      await pool.query(`ALTER TABLE payments ADD COLUMN hostel_id INT NULL`);
      // Populate hostel_id from allocations
      await pool.query(`
        UPDATE payments p
        INNER JOIN allocations a ON p.allocation_id = a.id
        SET p.hostel_id = a.hostel_id
        WHERE p.hostel_id IS NULL
      `);
      console.log('Added hostel_id column to payments table and populated from allocations');
    }
  } catch (err) {
    if (!err.message.includes('Duplicate column name')) {
      console.warn('Could not add hostel_id to payments:', err.message);
    }
  }

  console.log('Performance indexes added successfully!');

  // Password resets table for forgot password flow
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INT PRIMARY KEY AUTO_INCREMENT,
      phone VARCHAR(20) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone_expires (phone, expires_at),
      INDEX idx_phone_used (phone, used)
    )
  `);
  console.log('Password resets table created/verified');

  // Create index for faster lookups
  await createIndexIfNotExists('password_resets', 'idx_password_resets_phone_expires', 'phone, expires_at');
  await createIndexIfNotExists('password_resets', 'idx_password_resets_phone_used', 'phone, used');
  console.log('Added indexes on password_resets table');

  // SMS history table for tracking sent messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_history (
      id INT PRIMARY KEY AUTO_INCREMENT,
      student_id INT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      message_type VARCHAR(50) NOT NULL,
      message_content TEXT NOT NULL,
      message_status VARCHAR(20) NOT NULL DEFAULT 'sent',
      error_message TEXT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_by_user_id INT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      INDEX idx_student_id (student_id),
      INDEX idx_sent_at (sent_at),
      INDEX idx_message_type (message_type)
    )
  `);
  console.log('SMS history table created/verified');

  // Create indexes for SMS history
  await createIndexIfNotExists('sms_history', 'idx_sms_history_student_id', 'student_id');
  await createIndexIfNotExists('sms_history', 'idx_sms_history_sent_at', 'sent_at');
  await createIndexIfNotExists('sms_history', 'idx_sms_history_message_type', 'message_type');
  console.log('Added indexes on sms_history table');
}

module.exports = {
  runMigrations,
};

