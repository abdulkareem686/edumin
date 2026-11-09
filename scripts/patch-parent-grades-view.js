const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../views/school_app/parent-grades.ejs');
let content = fs.readFileSync(filePath, 'utf8');

// Replace sidebar + col-lg-9 start
const targetStart = `<div class="row">
                        <!-- Child Selection Sidebar -->
                        <div class="col-lg-3 mb-4">
                            <div class="card">
                                <div class="card-header bg-white">
                                    <h6 class="mb-0"><i class="bi bi-people me-2 text-primary"></i>My Children</h6>
                                </div>
                                <div class="card-body p-2">
                                    <% if (linkedStudents && linkedStudents.length > 0) { 
                                        for(var i = 0; i < linkedStudents.length; i++) { 
                                            var child = linkedStudents[i]; %>
                                            <div class="child-card <%= (student && student.id == child.id) ? 'active' : '' %>" 
                                                 onclick="window.location.href='/parent/grades?studentId=<%= child.id %>&term=<%= selectedTerm %>&academicYear=<%= selectedYear %>'">
                                                <div class="d-flex justify-content-between align-items-center">
                                                    <div>
                                                        <div class="child-name">
                                                            <%= child.firstName %> <%= child.middleName ? child.middleName + ' ' : '' %><%= child.lastName %>
                                                        </div>
                                                        <div class="text-muted small">
                                                            <i class="bi bi-mortarboard"></i> <%= child.className || 'Class not assigned' %>
                                                        </div>
                                                        <div class="text-muted small">
                                                            <i class="bi bi-card-text"></i> <%= child.admission_number || 'N/A' %>
                                                        </div>
                                                    </div>
                                                    <% if (student && student.id == child.id) { %>
                                                        <i class="bi bi-check-circle text-primary fs-5"></i>
                                                    <% } %>
                                                </div>
                                            </div>
                                    <% } 
                                    } else { %>
                                        <div class="text-center text-muted py-3">
                                            <i class="bi bi-inbox fs-1"></i>
                                            <p class="mt-2 mb-0">No children linked</p>
                                            <small>Please contact the school administrator</small>
                                        </div>
                                    <% } %>
                                </div>
                            </div>
                        </div>

                        <div class="col-lg-9">`;

const replacementStart = `<!-- Back to All Children Navigation -->
                    <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
                        <a href="/parent/children" class="btn btn-outline-primary btn-sm">
                            <i class="bi bi-arrow-left me-1"></i> Back to All Children
                        </a>
                        <% if (student) { %>
                        <div class="d-flex gap-2">
                            <a href="/parent/reports?studentId=<%= student.id %>" class="btn btn-outline-secondary btn-sm">
                                <i class="bi bi-file-earmark-text me-1"></i> Full Report Card
                            </a>
                            <a href="/parent/attendance?studentId=<%= student.id %>" class="btn btn-outline-secondary btn-sm">
                                <i class="bi bi-calendar-check me-1"></i> Attendance
                            </a>
                        </div>
                        <% } %>
                    </div>

                    <div class="col-12 px-0">`;

// Replace the closing tags and fallback
const targetEnd = `<% } else if (linkedStudents && linkedStudents.length > 0) { %>
                                <div class="alert alert-info text-center">
                                    <i class="bi bi-info-circle me-2"></i>
                                    Please select a child from the left sidebar to view their grades.
                                </div>
                            <% } %>
                        </div>
                    </div>`;

const replacementEnd = `<% } else { %>
                                <div class="card p-5 text-center shadow-sm border-0 my-4">
                                    <div class="text-muted mb-3">
                                        <i class="bi bi-people fs-1 text-primary"></i>
                                    </div>
                                    <h4 class="fw-bold">No Child Selected</h4>
                                    <p class="text-muted mb-4">Please select a child from the All Children page to view their grades and assessment scores.</p>
                                    <div>
                                        <a href="/parent/children?select=grades" class="btn btn-primary px-4">
                                            <i class="bi bi-arrow-left me-2"></i> Go to All Children
                                        </a>
                                    </div>
                                </div>
                            <% } %>
                        </div>`;

// Normalize line breaks for matching
const normContent = content.replace(/\r\n/g, '\n');
const normTargetStart = targetStart.replace(/\r\n/g, '\n');
const normTargetEnd = targetEnd.replace(/\r\n/g, '\n');

if (normContent.includes(normTargetStart) && normContent.includes(normTargetEnd)) {
    let updated = normContent.replace(normTargetStart, replacementStart.replace(/\r\n/g, '\n'));
    updated = updated.replace(normTargetEnd, replacementEnd.replace(/\r\n/g, '\n'));
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log('parent-grades.ejs patched successfully!');
} else {
    console.log('Targets not found in parent-grades.ejs');
    if (!normContent.includes(normTargetStart)) console.log('Start mismatch');
    if (!normContent.includes(normTargetEnd)) console.log('End mismatch');
}
