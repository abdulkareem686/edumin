const ejs = require('ejs');
const path = require('path');
const moment = require('moment');

const viewsDir = path.join(__dirname, '../views/school_app');

async function testViews() {
    console.log('--- TESTING VIEW RENDERING ---');

    // 1. Admin Payment Settings
    try {
        await ejs.renderFile(path.join(viewsDir, 'admin-payment-settings.ejs'), {
            school: { name: 'Alhamdulillahi Academy', bank_name: 'Zenith Bank', account_name: 'School', account_number: '1234567890', payment_instructions: 'Instructions' },
            activeAccount: { bank_name: 'Zenith Bank', account_name: 'School', account_number: '1234567890', instructions: 'Instructions' },
            accounts: [],
            success: 'Saved successfully',
            error: null,
            moment,
            role: 'admin',
            userRole: 'admin',
            username: 'Admin',
            userId: 1,
            session: { role: 'admin', userId: 1 },
            studentDisplayName: (s) => s?.firstName || ''
        }, { views: [viewsDir] });
        console.log('✓ admin-payment-settings.ejs rendered cleanly!');
    } catch (err) {
        console.error('Error rendering admin-payment-settings.ejs:', err);
        throw err;
    }

    // 2. Admin Pending Payments
    try {
        await ejs.renderFile(path.join(viewsDir, 'admin-pending-payments.ejs'), {
            payments: [{
                id: 1,
                firstName: 'Abdullahi',
                middleName: '',
                lastName: 'Smith',
                admission_number: 'ADM001',
                className: 'Primary 1',
                parent_first: 'John',
                parent_last: 'Doe',
                parent_phone: '08012345678',
                parent_email: 'john@example.com',
                term: 'First Term',
                academic_year: '2026/2027',
                payment_number: 1,
                amount: 25000,
                payment_method: 'Bank Transfer',
                bank_name: 'GTBank',
                transaction_reference: 'TXN123',
                proof_document: null,
                notes: 'Note',
                status: 'pending',
                rejection_reason: null,
                created_at: new Date(),
                fee_id: null
            }],
            stats: { pendingCount: 1, approvedCount: 2, rejectedCount: 0, pendingAmount: 25000, approvedAmount: 50000 },
            academicYears: [{ year_name: '2026/2027' }],
            terms: [{ term_name: 'First Term' }],
            filters: { status: 'all', academicYear: '', term: '', search: '' },
            success: null,
            error: null,
            moment,
            role: 'admin',
            userRole: 'admin',
            username: 'Admin',
            userId: 1,
            session: { role: 'admin', userId: 1 },
            studentDisplayName: (s) => s?.firstName || ''
        }, { views: [viewsDir] });
        console.log('✓ admin-pending-payments.ejs rendered cleanly!');
    } catch (err) {
        console.error('Error rendering admin-pending-payments.ejs:', err);
        throw err;
    }

    // 3. Parent Make Payment
    try {
        await ejs.renderFile(path.join(viewsDir, 'parent-make-payment.ejs'), {
            linkedStudents: [{ id: 3, firstName: 'Abdullahi', middleName: '', lastName: 'Smith', className: 'Primary 1', admission_number: 'ADM001' }],
            student: { id: 3, firstName: 'Abdullahi', middleName: '', lastName: 'Smith', className: 'Primary 1', admission_number: 'ADM001' },
            selectedStudentId: 3,
            school: { name: 'Alhamdulillahi Academy' },
            schoolAccount: { bank_name: 'Zenith Bank', account_name: 'School', account_number: '1234567890', instructions: 'Pay with admission number' },
            currentTermInfo: { academicYear: '2026/2027', currentTerm: 'First Term' },
            activeYear: '2026/2027',
            activeTerm: 'First Term',
            academicYears: [{ year_name: '2026/2027' }],
            terms: [{ term_name: 'First Term' }],
            termPaymentCount: 1,
            canPay: true,
            remainingPayments: 1,
            myPayments: [{
                id: 1,
                amount: 25000,
                firstName: 'Abdullahi',
                lastName: 'Smith',
                term: 'First Term',
                academic_year: '2026/2027',
                status: 'pending',
                payment_number: 1,
                transaction_reference: 'TXN123',
                created_at: new Date()
            }],
            username: 'Mr Parent',
            parentName: 'Mr Parent',
            unreadCount: 0,
            success: null,
            error: null,
            moment,
            role: 'parent',
            userRole: 'parent',
            userId: 1,
            session: { role: 'parent', parentId: 1 },
            studentDisplayName: (s) => s?.firstName || ''
        }, { views: [viewsDir] });
        console.log('✓ parent-make-payment.ejs rendered cleanly!');
    } catch (err) {
        console.error('Error rendering parent-make-payment.ejs:', err);
        throw err;
    }

    // 4. Parent Fees
    try {
        await ejs.renderFile(path.join(viewsDir, 'parent-fees.ejs'), {
            linkedStudents: [{ id: 3, firstName: 'Abdullahi', middleName: '', lastName: 'Smith', className: 'Primary 1', admission_number: 'ADM001' }],
            student: { id: 3, firstName: 'Abdullahi', middleName: '', lastName: 'Smith', className: 'Primary 1', admission_number: 'ADM001' },
            fees: [],
            feeSummary: { total_due: 50000, total_paid: 25000, total_balance: 25000, paid_percentage: 50, outstanding_count: 1, paid_count: 0, partial_count: 1 },
            paymentHistory: [],
            submittedPayments: [],
            termPaymentCount: 1,
            canPay: true,
            remainingPayments: 1,
            schoolAccount: { bank_name: 'Zenith Bank', account_name: 'School', account_number: '1234567890', instructions: 'Pay with admission no' },
            school: { name: 'Alhamdulillahi Academy' },
            currentTermInfo: { academicYear: '2026/2027', currentTerm: 'First Term' },
            academicYears: [{ year_name: '2026/2027' }],
            selectedStatus: 'all',
            parentName: 'Mr Parent',
            username: 'Mr Parent',
            unreadCount: 0,
            totalCount: 0,
            notifications: [],
            moment,
            paymentSubmitted: false,
            error: null,
            role: 'parent',
            userRole: 'parent',
            userId: 1,
            session: { role: 'parent', parentId: 1 },
            studentDisplayName: (s) => s?.firstName || ''
        }, { views: [viewsDir] });
        console.log('✓ parent-fees.ejs rendered cleanly!');
    } catch (err) {
        console.error('Error rendering parent-fees.ejs:', err);
        throw err;
    }

    console.log('--- ALL EJS VIEWS RENDERED PERFECTLY! ---');
    process.exit(0);
}

testViews().catch(() => process.exit(1));
