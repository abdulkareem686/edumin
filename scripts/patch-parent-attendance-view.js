const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../views/school_app/parent-attendance.ejs');
let content = fs.readFileSync(filePath, 'utf8');

// Target 1: Add Back to All Children navigation
const t1 = `<% if (error) { %>
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <i class="bi bi-exclamation-triangle me-2"></i> <%= error %>
                            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                        </div>
                    <% } %>`;

const r1 = `<% if (error) { %>
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <i class="bi bi-exclamation-triangle me-2"></i> <%= error %>
                            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                        </div>
                    <% } %>

                    <!-- Back to All Children Navigation -->
                    <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
                        <a href="/parent/children" class="btn btn-outline-primary btn-sm">
                            <i class="bi bi-arrow-left me-1"></i> Back to All Children
                        </a>
                        <% if (student) { %>
                        <div class="d-flex gap-2">
                            <a href="/parent/reports?studentId=<%= student.id %>" class="btn btn-outline-secondary btn-sm">
                                <i class="bi bi-file-earmark-text me-1"></i> Report Card
                            </a>
                            <a href="/parent/grades?studentId=<%= student.id %>" class="btn btn-outline-secondary btn-sm">
                                <i class="bi bi-clipboard-data me-1"></i> Grades
                            </a>
                        </div>
                        <% } %>
                    </div>`;

// Regex for Target 2
const t2Regex = /<%\s*}\s*else\s+if\s*\(linkedStudents\s*&&\s*linkedStudents\.length\)\s*\{\s*%>[\s\S]*?<%\s*}\s*else\s*\{\s*%>[\s\S]*?<%\s*}\s*%>/;

const r2 = `<% } else { %>
                            <div class="card p-5 text-center shadow-sm border-0 my-4">
                                <div class="text-muted mb-3">
                                    <i class="bi bi-calendar-check fs-1 text-primary"></i>
                                </div>
                                <h4 class="fw-bold">No Child Selected</h4>
                                <p class="text-muted mb-4">Please select a child from the All Children page to view their daily attendance breakdown.</p>
                                <div>
                                    <a href="/parent/children?select=attendance" class="btn btn-primary px-4">
                                        <i class="bi bi-arrow-left me-2"></i> Go to All Children
                                    </a>
                                </div>
                            </div>
                        <% } %>`;

let norm = content.replace(/\r\n/g, '\n');
const normT1 = t1.replace(/\r\n/g, '\n');

if (norm.includes(normT1) && t2Regex.test(norm)) {
    norm = norm.replace(normT1, r1.replace(/\r\n/g, '\n'));
    norm = norm.replace(t2Regex, r2.replace(/\r\n/g, '\n'));
    fs.writeFileSync(filePath, norm, 'utf8');
    console.log('parent-attendance.ejs patched successfully with regex!');
} else {
    console.log('Match failed:', norm.includes(normT1), t2Regex.test(norm));
}
