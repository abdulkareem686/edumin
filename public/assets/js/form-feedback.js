(function() {
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getAlertType(alert) {
        if (alert.classList.contains('alert-success')) return 'success';
        if (alert.classList.contains('alert-danger')) return 'danger';
        if (alert.classList.contains('alert-warning')) return 'warning';
        if (alert.classList.contains('alert-info')) return 'info';
        return 'info';
    }

    function getAlertIcon(type) {
        switch (type) {
            case 'success': return '✔';
            case 'danger': return '✕';
            case 'warning': return '!';
            default: return 'i';
        }
    }

    function showFeedbackToast(message, type) {
        if (!message) return;

        let container = document.getElementById('formFeedbackPopupContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'formFeedbackPopupContainer';
            container.setAttribute('aria-live', 'polite');
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = 'form-feedback-toast ' + type;
        toast.innerHTML = '<div class="form-feedback-icon">' + escapeHtml(getAlertIcon(type)) + '</div><div class="form-feedback-text">' + escapeHtml(message) + '</div>';
        container.appendChild(toast);

        requestAnimationFrame(function() {
            toast.classList.add('show');
        });

        setTimeout(function() {
            toast.classList.remove('show');
            setTimeout(function() {
                toast.remove();
            }, 260);
        }, 4500);
    }

    window.showFormFeedbackToast = showFeedbackToast;
    window.showToast = showFeedbackToast;

    function initFormFeedback() {
        const alerts = Array.from(document.querySelectorAll('.alert-success, .alert-danger, .alert-warning, .alert-info'));

        alerts.forEach(function(alert) {
            if (alert.dataset.feedbackHandled === 'true') return;
            alert.dataset.feedbackHandled = 'true';

            const text = (alert.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) return;

            showFeedbackToast(text, getAlertType(alert));
        });
    }

    document.addEventListener('DOMContentLoaded', initFormFeedback);
    window.addEventListener('load', initFormFeedback);
})();
