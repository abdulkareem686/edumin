-- Run once (or on boot via tryApplyScaleIndexes). Duplicate index names are ignored.
-- Safe to re-run.

CREATE INDEX idx_students_school_class ON students (school_id, classId);
CREATE INDEX idx_students_school_name ON students (school_id, lastName, firstName);
CREATE INDEX idx_students_email ON students (email);
CREATE INDEX idx_students_admission ON students (admission_number);

CREATE INDEX idx_parents_school ON parents (school_id);
CREATE INDEX idx_parents_email ON parents (email);

CREATE INDEX idx_parent_students_parent ON parent_students (parent_id);
CREATE INDEX idx_parent_students_student ON parent_students (student_id);

CREATE INDEX idx_teachers_school ON teachers (school_id);
CREATE INDEX idx_staff_school ON staff (school_id);
CREATE INDEX idx_classes_school ON classes (school_id);

CREATE INDEX idx_scores_school_student ON student_scores (school_id, student_id);
CREATE INDEX idx_scores_year_term ON student_scores (academic_year, term, school_id);

CREATE INDEX idx_fees_school_student ON fees (school_id, studentId);
CREATE INDEX idx_fees_year_term ON fees (academicYear, term, school_id);

CREATE INDEX idx_admin_notif_admin ON admin_notifications (admin_id, is_read);
CREATE INDEX idx_users_username ON users (username);
CREATE INDEX idx_users_email ON users (email);

ALTER TABLE promotion_history MODIFY COLUMN to_class INT(11) NULL DEFAULT NULL;
ALTER TABLE promotion_history MODIFY COLUMN action ENUM('promoted', 'repeated', 'graduated') NOT NULL;
