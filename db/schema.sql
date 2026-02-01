-- Hostel Management System - MySQL schema (reference file)
-- NOTE: The Node.js backend will automatically create these tables and seed roles + Super Admin
-- on startup via src/db/migrations.js, using environment variables for Super Admin credentials.

CREATE TABLE hostels (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  location VARCHAR(255),
  contact_phone VARCHAR(30),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL UNIQUE,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL,
  hostel_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (hostel_id) REFERENCES hostels(id)
);

CREATE TABLE rooms (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  capacity INT NOT NULL,
  hostel_id INT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hostel_id) REFERENCES hostels(id)
);

CREATE TABLE students (
  id INT PRIMARY KEY AUTO_INCREMENT,
  full_name VARCHAR(150) NOT NULL,
  registration_number VARCHAR(50) NOT NULL UNIQUE,
  phone VARCHAR(20),
  email VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE allocations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  student_id INT NOT NULL,
  room_id INT NOT NULL,
  room_price_at_allocation DECIMAL(10, 2) NOT NULL,
  allocated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE TABLE payments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  allocation_id INT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  recorded_by_user_id INT NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (allocation_id) REFERENCES allocations(id),
  FOREIGN KEY (recorded_by_user_id) REFERENCES users(id)
);

CREATE TABLE expenses (
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
  FOREIGN KEY (recorded_by_user_id) REFERENCES users(id)
);


