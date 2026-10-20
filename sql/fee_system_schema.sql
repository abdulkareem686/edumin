-- ============================================================================
-- EDUSUITE SCHOOL MANAGEMENT SYSTEM: COMPLETE FEE & PAYMENT SUBSYSTEM SCHEMA
-- ============================================================================
-- This script contains the unified database schema connecting:
--   1. School Bank Account Settings (`school_info`, `payment_accounts`)
--   2. Class Bills Configuration (`class_bills`)
--   3. Parent Portal Fee Submissions (`parent_payments` with 2/term limit)
--   4. Official Fees & Collection Ledger (`fees`)
--   5. Real-time Notifications (`parent_notifications`, `admin_notifications`)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SCHOOL INFORMATION (Adding Bank Account Columns)
-- ----------------------------------------------------------------------------
-- Ensure bank account details exist on school_info table
ALTER TABLE `school_info`
  ADD COLUMN IF NOT EXISTS `bank_name` VARCHAR(150) DEFAULT NULL AFTER `website`,
  ADD COLUMN IF NOT EXISTS `account_name` VARCHAR(150) DEFAULT NULL AFTER `bank_name`,
  ADD COLUMN IF NOT EXISTS `account_number` VARCHAR(50) DEFAULT NULL AFTER `account_name`,
  ADD COLUMN IF NOT EXISTS `payment_instructions` TEXT DEFAULT NULL AFTER `account_number`;

-- ----------------------------------------------------------------------------
-- 2. SCHOOL PAYMENT ACCOUNTS TABLE (`payment_accounts`)
-- Stores active bank accounts configured by the School Administrator.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payment_accounts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `school_id` INT DEFAULT NULL,
  `bank_name` VARCHAR(150) NOT NULL COMMENT 'e.g. Zenith Bank, GTBank, First Bank',
  `account_name` VARCHAR(150) NOT NULL COMMENT 'Name of account holder / school fee account',
  `account_number` VARCHAR(50) NOT NULL COMMENT '10-digit NUBAN or collection account number',
  `instructions` TEXT DEFAULT NULL COMMENT 'Custom instructions displayed to parents',
  `is_active` TINYINT(1) DEFAULT 1 COMMENT '1 = Active account, 0 = Inactive',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_payment_accounts_school` (`school_id`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. CLASS BILLS CONFIGURATION TABLE (`class_bills`)
-- Defines the fee structure for each class, academic year, and term.
-- e.g. Class: JSS 1 | Fee: Tuition | Amount: ₦45,000 | Year: 2026/2027 | Term: First Term
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `class_bills` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `class_id` INT NOT NULL COMMENT 'References classes.id',
  `class_name` VARCHAR(100) DEFAULT NULL,
  `level` VARCHAR(50) DEFAULT NULL,
  `department` VARCHAR(50) DEFAULT NULL,
  `fee_type` VARCHAR(100) NOT NULL COMMENT 'Tuition, Examination, Development, Sports, Uniform, etc.',
  `amount` DECIMAL(12,2) NOT NULL COMMENT 'Amount due for this line item in Naira',
  `academic_year` VARCHAR(50) NOT NULL COMMENT 'e.g. 2026/2027',
  `term` ENUM('First Term','Second Term','Third Term') NOT NULL,
  `description` TEXT DEFAULT NULL,
  `due_date` DATE DEFAULT NULL,
  `is_active` TINYINT(1) DEFAULT 1,
  `created_by` INT DEFAULT NULL COMMENT 'References users.id',
  `school_id` INT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_class_bills_class_session` (`class_id`, `academic_year`, `term`, `is_active`),
  INDEX `idx_class_bills_school` (`school_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 4. OFFICIAL FEES COLLECTION LEDGER TABLE (`fees`)
-- Master fee records tracking official student bills, amounts paid, balances,
-- generated receipts, and payment status (paid, partial, pending, overpaid).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fees` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `studentId` INT NOT NULL COMMENT 'References students.id',
  `admission_number` VARCHAR(50) DEFAULT NULL,
  `studentName` VARCHAR(150) NOT NULL,
  `email` VARCHAR(100) DEFAULT NULL,
  `className` VARCHAR(100) DEFAULT NULL,
  `department` VARCHAR(50) DEFAULT NULL,
  `feeType` VARCHAR(100) NOT NULL DEFAULT 'School Fees',
  `paymentType` VARCHAR(50) DEFAULT 'Bank Transfer' COMMENT 'Bank Transfer, Cash, POS, Online',
  `amount` DECIMAL(12,2) NOT NULL COMMENT 'Total billed amount',
  `billAmount` DECIMAL(12,2) NOT NULL COMMENT 'Official bill amount from class_bills',
  `amountPaid` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Cumulative total paid so far',
  `balance` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Remaining amount owed (billAmount - amountPaid)',
  `paymentDate` DATE NOT NULL,
  `receiptNumber` VARCHAR(100) NOT NULL UNIQUE COMMENT 'Official generated school receipt number',
  `academicYear` VARCHAR(50) NOT NULL COMMENT 'e.g. 2026/2027',
  `term` ENUM('First Term','Second Term','Third Term') NOT NULL,
  `notes` TEXT DEFAULT NULL,
  `status` ENUM('pending','partial','paid','overpaid') NOT NULL DEFAULT 'pending',
  `school_id` INT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_fees_student_term` (`studentId`, `academicYear`, `term`),
  INDEX `idx_fees_receipt` (`receiptNumber`),
  INDEX `idx_fees_status` (`school_id`, `status`),
  INDEX `idx_fees_academic` (`academicYear`, `term`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 5. PARENT FEE PAYMENTS & APPROVALS TABLE (`parent_payments`)
-- Records payments submitted by parents through the Parent Portal.
-- Enforces: Max 2 payments per academic term per student.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `parent_payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `school_id` INT DEFAULT NULL,
  `parent_id` INT NOT NULL COMMENT 'References parents.id',
  `student_id` INT NOT NULL COMMENT 'References students.id',
  `academic_year` VARCHAR(50) NOT NULL COMMENT 'e.g. 2026/2027',
  `term` VARCHAR(50) NOT NULL COMMENT 'First Term, Second Term, Third Term',
  `amount` DECIMAL(12,2) NOT NULL COMMENT 'Amount paid in Naira',
  `payment_method` VARCHAR(50) DEFAULT 'Bank Transfer' COMMENT 'Bank Transfer, Bank Deposit, USSD, POS',
  `bank_name` VARCHAR(100) DEFAULT NULL COMMENT 'Bank name transferred from',
  `transaction_reference` VARCHAR(100) DEFAULT NULL COMMENT 'Bank transfer reference or teller number',
  `payment_date` DATE NOT NULL,
  `proof_document` VARCHAR(255) DEFAULT NULL COMMENT 'File path to uploaded payment slip / teller',
  `notes` TEXT DEFAULT NULL COMMENT 'Parent notes / description',
  `status` ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `rejection_reason` TEXT DEFAULT NULL COMMENT 'Admin note if declined',
  `payment_number` INT NOT NULL DEFAULT 1 COMMENT '1 = First payment in term, 2 = Second payment in term (max 2)',
  `fee_id` INT DEFAULT NULL COMMENT 'Linked to fees.id once approved by admin',
  `approved_by` INT DEFAULT NULL COMMENT 'References users.id (admin who verified)',
  `approved_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_parent_payments_term_count` (`student_id`, `academic_year`, `term`, `status`),
  INDEX `idx_parent_payments_parent` (`parent_id`),
  INDEX `idx_parent_payments_approval` (`school_id`, `status`),
  INDEX `idx_parent_payments_fee_link` (`fee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 6. NOTIFICATION TABLES (`parent_notifications` & `admin_notifications`)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `parent_notifications` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,
  `school_id` INT DEFAULT NULL,
  `title` VARCHAR(150) NOT NULL,
  `message` TEXT NOT NULL,
  `type` VARCHAR(50) DEFAULT 'general',
  `reference_id` INT DEFAULT NULL,
  `is_read` TINYINT(1) DEFAULT 0,
  `read_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_parent_notif_unread` (`parent_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `admin_notifications` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `admin_id` INT DEFAULT NULL,
  `school_id` INT DEFAULT NULL,
  `title` VARCHAR(150) NOT NULL,
  `message` TEXT NOT NULL,
  `type` VARCHAR(50) DEFAULT 'general',
  `reference_id` INT DEFAULT NULL,
  `is_read` TINYINT(1) DEFAULT 0,
  `read_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_admin_notif_unread` (`admin_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- WORKFLOW RECONCILIATION SUMMARY
-- ============================================================================
-- 1. [Admin] Sets Bank Details in `school_info` & `payment_accounts`.
-- 2. [Admin] Sets Class Fees in `class_bills` (e.g. Tuition, Exam, Sports).
-- 3. [Parent] Opens Parent Portal:
--       - Sees School Bank Account.
--       - Sees Total Class Bill & line items from `class_bills`.
--       - Sees Previous Paid and Outstanding Balance from `fees`.
--       - Sees Term Payment Count: 0/2, 1/2, or 2/2 (Max 2 Allowed).
--       - Submits payment with proof & reference -> recorded in `parent_payments` (status: 'pending').
-- 4. [Admin] Reviews at `/admin/pending-payments`:
--       - On Approve: Calculates total bill from `class_bills`, checks existing `fees` row,
--         updates/inserts into `fees`, updates `parent_payments.status` = 'approved',
--         links `fee_id`, issues official `receiptNumber`, notifies parent.
-- 5. [Admin] Reviews at `/fees-collection`:
--       - Real-time ledger reflects student's updated payment, balance, and official receipt!
-- ============================================================================
