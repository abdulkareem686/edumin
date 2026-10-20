const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../views/school_app/parent-make-payment.ejs');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Insert Class Bill Card into parent-make-payment.ejs right after termLimitAlertBox
const targetBox = `<div class="progress" style="height: 6px;">
                                            <div id="termProgressBar" class="progress-bar <%= termPaymentCount >= 2 ? 'bg-danger' : (termPaymentCount == 1 ? 'bg-warning' : 'bg-success') %>" 
                                                 style="width: <%= (termPaymentCount / 2) * 100 %>%;"></div>
                                        </div>
                                    </div>`;

const billCardHtml = `<div class="progress" style="height: 6px;">
                                            <div id="termProgressBar" class="progress-bar <%= termPaymentCount >= 2 ? 'bg-danger' : (termPaymentCount == 1 ? 'bg-warning' : 'bg-success') %>" 
                                                 style="width: <%= (termPaymentCount / 2) * 100 %>%;"></div>
                                        </div>
                                    </div>

                                    <!-- Class Bill & Balance Breakdown Card -->
                                    <div class="card bg-light border mb-4">
                                        <div class="card-body p-3">
                                            <div class="d-flex justify-content-between align-items-center mb-2">
                                                <h6 class="mb-0 fw-bold text-dark">
                                                    <i class="bi bi-receipt-cutoff me-1 text-primary"></i> Class Fee Bill & Outstanding Balance
                                                </h6>
                                                <span class="badge bg-primary-light text-primary" id="classDisplayBadge">
                                                    <%= student ? (student.className || 'Class Bill') : 'Class Bill' %>
                                                </span>
                                            </div>

                                            <div class="row g-2 text-center my-2">
                                                <div class="col-4">
                                                    <div class="p-2 bg-white rounded border">
                                                        <small class="text-muted d-block">Total Billed</small>
                                                        <span class="fw-bold text-dark fs-6" id="totalBillDisplay">
                                                            ₦<%= (typeof totalClassBill !== 'undefined' ? totalClassBill : 0).toLocaleString() %>
                                                        </span>
                                                    </div>
                                                </div>
                                                <div class="col-4">
                                                    <div class="p-2 bg-white rounded border">
                                                        <small class="text-muted d-block">Amount Paid</small>
                                                        <span class="fw-bold text-success fs-6" id="totalPaidDisplay">
                                                            ₦<%= (typeof totalPaidSoFar !== 'undefined' ? totalPaidSoFar : 0).toLocaleString() %>
                                                        </span>
                                                    </div>
                                                </div>
                                                <div class="col-4">
                                                    <div class="p-2 bg-white rounded border border-warning">
                                                        <small class="text-muted d-block">Balance Due</small>
                                                        <span class="fw-bold text-danger fs-6" id="balanceDisplay">
                                                            ₦<%= (typeof outstandingBalance !== 'undefined' ? outstandingBalance : 0).toLocaleString() %>
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            <!-- Fee Line Items Breakdown Accordion/Collapse -->
                                            <div class="mt-2" id="billBreakdownContainer">
                                                <% if (typeof classBills !== 'undefined' && classBills && classBills.length > 0) { %>
                                                    <div class="table-responsive">
                                                        <table class="table table-sm table-borderless mb-0 small">
                                                            <tbody>
                                                                <% classBills.forEach(function(b) { %>
                                                                    <tr class="border-bottom border-light">
                                                                        <td class="text-muted py-1"><i class="bi bi-dot"></i> <%= b.fee_type %></td>
                                                                        <td class="text-end fw-semibold py-1">₦<%= parseFloat(b.amount).toLocaleString() %></td>
                                                                    </tr>
                                                                <% }); %>
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                <% } %>
                                            </div>

                                            <% if (typeof outstandingBalance !== 'undefined' && outstandingBalance > 0 && termPaymentCount < 2) { %>
                                                <div class="d-flex gap-2 mt-3 pt-2 border-top">
                                                    <button type="button" class="btn btn-sm btn-outline-primary flex-fill" onclick="setPaymentAmount(<%= outstandingBalance %>)">
                                                        <i class="bi bi-wallet2 me-1"></i> Pay Full Balance (₦<%= outstandingBalance.toLocaleString() %>)
                                                    </button>
                                                    <button type="button" class="btn btn-sm btn-outline-secondary flex-fill" onclick="setPaymentAmount(<%= Math.round(outstandingBalance / 2) %>)">
                                                        Pay 50% (₦<%= Math.round(outstandingBalance / 2).toLocaleString() %>)
                                                    </button>
                                                </div>
                                            <% } %>
                                        </div>
                                    </div>`;

if (!content.includes('Class Fee Bill & Outstanding Balance')) {
    content = content.replace(targetBox, billCardHtml);
    console.log('Class Bill card added to parent-make-payment.ejs');
}

// 2. Enhance onTermOrYearChanged and add setPaymentAmount in script
const oldScript = `                    if (count >= 2) {`;
const newScriptPart = `                    // Update bill & balance figures
                    if (data.totalClassBill !== undefined) {
                        const billEl = document.getElementById('totalBillDisplay');
                        const paidEl = document.getElementById('totalPaidDisplay');
                        const balEl = document.getElementById('balanceDisplay');
                        if (billEl) billEl.textContent = '₦' + (data.totalClassBill || 0).toLocaleString();
                        if (paidEl) paidEl.textContent = '₦' + (data.totalPaidSoFar || 0).toLocaleString();
                        if (balEl) balEl.textContent = '₦' + (data.outstandingBalance || 0).toLocaleString();

                        // Update breakdown table
                        const bContainer = document.getElementById('billBreakdownContainer');
                        if (bContainer && data.classBills && data.classBills.length > 0) {
                            let rows = '<div class="table-responsive"><table class="table table-sm table-borderless mb-0 small"><tbody>';
                            data.classBills.forEach(b => {
                                rows += \`<tr class="border-bottom border-light"><td class="text-muted py-1"><i class="bi bi-dot"></i> \${b.fee_type}</td><td class="text-end fw-semibold py-1">₦\${parseFloat(b.amount).toLocaleString()}</td></tr>\`;
                            });
                            rows += '</tbody></table></div>';
                            bContainer.innerHTML = rows;
                        }
                    }

                    if (count >= 2) {`;

if (!content.includes('setPaymentAmount(amount)')) {
    content = content.replace(oldScript, newScriptPart);
    const helperFn = `        function setPaymentAmount(amount) {
            const input = document.getElementById('amount');
            if (input) {
                input.value = amount;
                input.focus();
            }
        }\n\n        function copySchoolAccount() {`;
    content = content.replace('function copySchoolAccount() {', helperFn);
    console.log('setPaymentAmount and dynamic bill update script added');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('parent-make-payment.ejs updated successfully');
