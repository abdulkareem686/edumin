const classSelect = document.getElementById('class-select');
      const classarmSelect = document.getElementById('class-arms');
      
      const classSubjects = {
        'Basic Class': ['Basic 1', 'Basic 2', 'Basic 3', 'Basic 4', 'Basic 5'],
        'JSS Class': ['JSS 1', 'JSS 2', 'JSS 3'],
        'SSS Class': ['SSS 1', 'SSS 2', 'SSS 3']
      };
      
      window.onload=function updateSubjects() {
        const selectedClass = classSelect.value;
        classarmSelect.disabled = false;
        classarmSelect.innerHTML = '<option value="">Select Classes</option>';
        
        if (selectedClass) {
          classSubjects[selectedClass].forEach(subject => {
            const option = document.createElement('option');
            option.value = subject;
            option.text = subject;
            classarmSelect.appendChild(option);
          });
        }
      }

      // Global JavaScript functions can be added here
document.addEventListener('DOMContentLoaded', function() {
  // Any global DOM ready code
});