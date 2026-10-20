// utils/grading.js
// Single source of truth for grade boundaries and labels.
//
// Consolidated from every getGrade/calculateGrade, getGradeClass, getGradeColor,
// getPerformanceRemark, getPosition, getGradePoint, and getGradeRemark definition
// previously scattered through server.js.
//
// NOTE on this revision: two real divergences were found and fixed here, not just
// duplicated:
//   1. getPosition() was missing the 40-49 tier that every other function has,
//      so a 40-49 score fell straight into the same bucket as an outright fail.
//   2. getGradeRemark(grade, score) used a different label set than
//      getPerformanceRemark(score) for the same score ranges (D->'Fair' vs
//      'Satisfactory', E->'Pass' vs 'Fair', F->'Fail' vs 'Needs Improvement'),
//      so the same student's row could show contradictory remarks depending on
//      which route rendered it. getGradeRemark now returns the same wording as
//      getPerformanceRemark.

function getGrade(score) {
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    if (score >= 50) return 'D';
    if (score >= 40) return 'E';
    return 'F';
}

function getGradeClass(grade) {
    switch (grade) {
        case 'A': return 'grade-A';
        case 'B': return 'grade-B';
        case 'C': return 'grade-C';
        case 'D': return 'grade-D';
        case 'E': return 'grade-E';
        default: return 'grade-F';
    }
}

function getGradeColor(score) {
    if (score >= 80) return 'success';
    if (score >= 70) return 'info';
    if (score >= 60) return 'primary';
    if (score >= 50) return 'warning';
    if (score >= 40) return 'secondary';
    return 'danger';
}

function getPerformanceRemark(score) {
    if (score >= 80) return 'Excellent';
    if (score >= 70) return 'Very Good';
    if (score >= 60) return 'Good';
    if (score >= 50) return 'Satisfactory';
    if (score >= 40) return 'Fair';
    return 'Needs Improvement';
}

function getPosition(score) {
    if (score >= 80) return 'Top Performer';
    if (score >= 70) return 'Above Average';
    if (score >= 60) return 'Average';
    if (score >= 50) return 'Below Average';
    if (score >= 40) return 'Fair';
    return 'Needs Improvement';
}

function getGradePoint(grade) {
    switch (grade) {
        case 'A': return 5.0;
        case 'B': return 4.0;
        case 'C': return 3.0;
        case 'D': return 2.0;
        case 'E': return 1.0;
        default: return 0.0;
    }
}

// grade is the letter (from getGrade); score is optional and unused for now,
// kept for call-site compatibility. Wording matches getPerformanceRemark.
function getGradeRemark(grade, score) {
    switch (grade) {
        case 'A': return 'Excellent';
        case 'B': return 'Very Good';
        case 'C': return 'Good';
        case 'D': return 'Satisfactory';
        case 'E': return 'Fair';
        default: return 'Needs Improvement';
    }
}

module.exports = {
    getGrade,
    getGradeClass,
    getGradeColor,
    getPerformanceRemark,
    getPosition,
    getGradePoint,
    getGradeRemark
};
