document.addEventListener('DOMContentLoaded', function() {
  // Mobile menu toggle
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileMenu = document.getElementById('mobile-menu');
  
  if (mobileMenuBtn && mobileMenu) {
    mobileMenuBtn.addEventListener('click', function() {
      mobileMenu.classList.toggle('hidden');
    });
  }
  
  // Form validation
  const forms = document.querySelectorAll('form');
  
  forms.forEach(form => {
    form.addEventListener('submit', function(e) {
      const requiredFields = form.querySelectorAll('[required]');
      let isValid = true;
      
      requiredFields.forEach(field => {
        if (!field.value.trim()) {
          isValid = false;
          field.classList.add('error');
        } else {
          field.classList.remove('error');
        }
      });
      
      if (!isValid) {
        e.preventDefault();
        alert('Please fill in all required fields');
      }
    });
  });
  
  // Amount formatting
  const amountInputs = document.querySelectorAll('input[type="number"]');
  
  amountInputs.forEach(input => {
    input.addEventListener('blur', function() {
      if (this.value) {
        this.value = parseFloat(this.value).toFixed(2);
      }
    });
  });
  
  // Service cards animation
  const serviceCards = document.querySelectorAll('.service-card');
  
  serviceCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.style.transform = 'translateY(-5px)';
    });
    
    card.addEventListener('mouseleave', function() {
      this.style.transform = '';
    });
  });
});

// Password strength indicator
const passwordInput = document.getElementById('password');
if (passwordInput) {
  const passwordStrength = document.createElement('div');
  passwordStrength.className = 'password-strength';
  passwordInput.parentNode.insertBefore(passwordStrength, passwordInput.nextSibling);
  
  passwordInput.addEventListener('input', function() {
    const password = this.value;
    let strength = 0;
    
    // Length check
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    
    // Character variety checks
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++;
    
    // Update strength indicator
    passwordStrength.className = 'password-strength';
    if (password.length === 0) {
      passwordStrength.style.display = 'none';
    } else {
      passwordStrength.style.display = 'block';
      if (strength <= 2) {
        passwordStrength.classList.add('strength-weak');
      } else if (strength <= 4) {
        passwordStrength.classList.add('strength-medium');
      } else {
        passwordStrength.classList.add('strength-strong');
      }
    }
  });
}

// Confirm password validation
const confirmPasswordInput = document.getElementById('confirmPassword');
if (confirmPasswordInput && passwordInput) {
  confirmPasswordInput.addEventListener('input', function() {
    if (this.value !== passwordInput.value) {
      this.setCustomValidity("Passwords don't match");
    } else {
      this.setCustomValidity('');
    }
  });
}