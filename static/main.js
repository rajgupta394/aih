/**
 * Frontend logic for the AIH Attendance System.
 * Focus on a professional, mobile-first, modal-driven UX.
 */

// =============================================================================
// === UTILITY & HELPER FUNCTIONS =============================================
// =============================================================================

function showStatusMessage(message, type) {
    const statusDiv = document.getElementById('status-message');
    if (!statusDiv) return;
    statusDiv.textContent = message;
    statusDiv.className = `status-message ${type}`;
    statusDiv.style.display = 'block';
    setTimeout(() => { statusDiv.style.display = 'none'; }, 5000);
}

function getAccurateLocation(successCallback, errorCallback) {
    showStatusMessage('Getting location...', 'info');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            if (pos.coords.accuracy < 150) {
                successCallback(pos);
            } else {
                showStatusMessage('Improving location accuracy...', 'info');
                const watchId = navigator.geolocation.watchPosition(
                    (highAccPos) => {
                        navigator.geolocation.clearWatch(watchId);
                        successCallback(highAccPos);
                    },
                    (err) => {
                        navigator.geolocation.clearWatch(watchId);
                        errorCallback(`Could not get an accurate location: ${err.message}`);
                    },
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
                );
            }
        },
        (err) => { errorCallback(`Could not get location: ${err.message}`); },
        { enableHighAccuracy: false, timeout: 5000 }
    );
}

function startRobustTimer(endTimeIsoString, timerElement) {
    if (!endTimeIsoString || !timerElement) return;
    const endTime = new Date(endTimeIsoString).getTime();
    const timerInterval = setInterval(() => {
        const remaining = endTime - new Date().getTime();
        if (remaining <= 0) {
            clearInterval(timerInterval);
            timerElement.textContent = "Session Ended";
            if (document.body.contains(document.getElementById('attendance-form'))) {
                window.location.reload();
            }
            return;
        }
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        timerElement.textContent = `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
    }, 1000);
}

const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
};

// =============================================================================
// === PAGE INITIALIZERS =======================================================
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('attendance-form')) initStudentPage();
    if (document.querySelector('.dashboard-content')) initControllerDashboard();
    if (document.querySelector('.professional-table')) initReportPage();
});

function initStudentPage() {
    const attendanceForm = document.getElementById('attendance-form');
    if (!attendanceForm) return;
    
    const markButton = document.getElementById('mark-btn');
    const enrollmentInput = document.getElementById('enrollment_no');
    
    if (window.activeSessionDataStudent?.end_time) {
        const timerElement = document.getElementById('timer-student');
        startRobustTimer(window.activeSessionDataStudent.end_time, timerElement);
    }
    
    enrollmentInput.addEventListener('input', debounce(async () => {
        const studentNameDisplay = document.getElementById('student-name-display');
        const enrollmentNo = enrollmentInput.value.trim();
        if (enrollmentNo.length >= 5) {
            const response = await fetch(`/api/get_student_name/${enrollmentNo}`);
            const data = await response.json();
            studentNameDisplay.textContent = data.name ? `Name: ${data.name}` : 'Student not found.';
            studentNameDisplay.style.color = data.name ? 'var(--primary-blue)' : 'var(--danger-red)';
        } else {
            studentNameDisplay.textContent = '';
        }
    }, 300));

    attendanceForm.addEventListener('submit', (e) => {
        e.preventDefault();
        markButton.disabled = true;
        markButton.textContent = 'Verifying...';
        getAccurateLocation(
            async (position) => {
                markButton.textContent = 'Submitting...';
                const formData = new URLSearchParams({
                    enrollment_no: enrollmentInput.value,
                    session_id: window.activeSessionDataStudent.id,
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                });
                const response = await fetch('/api/mark_attendance', { method: 'POST', body: formData });
                const result = await response.json();
                showStatusMessage(result.message, result.category);
                if (result.success) {
                    attendanceForm.style.display = 'none';
                } else {
                    markButton.disabled = false;
                    markButton.textContent = 'Mark My Attendance';
                }
            },
            (error) => {
                showStatusMessage(error, 'error');
                markButton.disabled = false;
                markButton.textContent = 'Mark My Attendance';
            }
        );
    });
}

function initControllerDashboard() {
    const startButton = document.getElementById('start-session-btn');
    const endButton = document.querySelector('.end-session-btn');
    const liveManagerBtn = document.getElementById('live-manager-btn');

    if (window.activeSessionData?.id) {
        const timerElement = document.getElementById(`timer-${window.activeSessionData.id}`);
        startRobustTimer(window.activeSessionData.end_time, timerElement);
    }

    if (startButton) {
        startButton.addEventListener('click', () => {
            startButton.disabled = true;
            startButton.textContent = 'Getting Location...';
            getAccurateLocation(async (position) => {
                startButton.textContent = 'Starting...';
                const response = await fetch('/api/start_session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
                });
                const result = await response.json();
                if (result.success) {
                    window.location.reload();
                } else {
                    showStatusMessage(result.message, 'error');
                    startButton.disabled = false;
                    startButton.textContent = 'Start New Session';
                }
            }, (error) => {
                showStatusMessage(error, 'error');
                startButton.disabled = false;
                startButton.textContent = 'Start New Session';
            });
        });
    }
    
    if (endButton) {
        endButton.addEventListener('click', async function() {
            this.disabled = true;
            await fetch(`/api/end_session/${this.dataset.sessionId}`, { method: 'POST' });
            window.location.reload();
        });
    }

    if (liveManagerBtn) {
        liveManagerBtn.addEventListener('click', () => {
            const sessionId = liveManagerBtn.dataset.sessionId;
            setupManagerModal({
                title: "Live Attendance Manager",
                subtitle: `Session ID: ${sessionId}`,
                fetchUrl: `/api/get_students_for_session/${sessionId}`,
                apiUrl: '/api/toggle_attendance_for_session',
                payload: { session_id: sessionId }
            });
        });
    }
}

function initReportPage() {
    // Edit day functionality
    document.querySelectorAll('.edit-day-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            const date = e.target.dataset.date;
            setupManagerModal({
                title: "Edit Attendance",
                subtitle: `Date: ${date}`,
                fetchUrl: `/api/get_students_for_day/${date}`,
                apiUrl: '/api/toggle_attendance_for_day',
                payload: { date: date }
            });
        });
    });

    // Delete day functionality
    const deleteModal = document.getElementById('confirm-delete-modal');
    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    const deleteDateDisplay = document.getElementById('modal-delete-date-display');
    let dateToDelete = null;

    document.querySelectorAll('.delete-day-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            dateToDelete = e.target.dataset.date;
            deleteDateDisplay.textContent = dateToDelete;
            deleteModal.style.display = 'block';
            document.body.classList.add('modal-open');
        });
    });

    confirmDeleteBtn.addEventListener('click', async () => {
        if (!dateToDelete) return;
        confirmDeleteBtn.disabled = true;
        const response = await fetch(`/api/delete_day/${dateToDelete}`, { method: 'DELETE' });
        const result = await response.json();
        showStatusMessage(result.message, result.success ? 'success' : 'error');
        if (result.success) {
            document.getElementById(`row-${dateToDelete}`).remove();
        }
        closeModal(deleteModal);
        confirmDeleteBtn.disabled = false;
    });

    deleteModal.querySelectorAll('.close-btn').forEach(btn => btn.addEventListener('click', () => closeModal(deleteModal)));
}


// =============================================================================
// === MODAL MANAGER (REUSABLE LOGIC) ==========================================
// =============================================================================

const managerModal = document.getElementById('manager-modal');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const studentListContainer = document.getElementById('student-list-container');
const searchInput = document.getElementById('student-search-input');

async function setupManagerModal(config) {
    modalTitle.textContent = config.title;
    modalSubtitle.textContent = config.subtitle;
    studentListContainer.innerHTML = '<p style="text-align:center;">Loading students...</p>';
    openModal(managerModal);
    
    const response = await fetch(config.fetchUrl);
    const data = await response.json();

    if (data.success) {
        renderStudentList(data.students, config);
        searchInput.oninput = () => renderStudentList(data.students.filter(s => 
            s.name.toLowerCase().includes(searchInput.value.toLowerCase()) || 
            s.enrollment_no.toLowerCase().includes(searchInput.value.toLowerCase())
        ), config);
    } else {
        studentListContainer.innerHTML = `<p class="error">${data.message}</p>`;
    }
}

function renderStudentList(students, config) {
    studentListContainer.innerHTML = '';
    if (students.length === 0) {
        studentListContainer.innerHTML = '<p style="text-align:center;">No students match your search.</p>';
        return;
    }
    students.forEach(student => {
        const item = document.createElement('div');
        item.className = 'student-item';
        item.innerHTML = `
            <div class="student-info">
                <div class="name">${student.name}</div>
                <div class="enrollment">${student.enrollment_no}</div>
            </div>
            <button class="button attendance-toggle-btn ${student.is_present ? 'is-present' : 'is-absent'}" data-student-id="${student.id}">
                ${student.is_present ? 'Mark Absent' : 'Mark Present'}
            </button>
        `;
        studentListContainer.appendChild(item);
    });

    studentListContainer.querySelectorAll('.attendance-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const button = e.target;
            const studentId = button.dataset.studentId;
            const isCurrentlyPresent = button.classList.contains('is-present');
            
            button.disabled = true; // Prevent double-clicks
            
            const response = await fetch(config.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...config.payload, student_id: studentId, is_present: !isCurrentlyPresent })
            });

            const result = await response.json();
            if (result.success) {
                // Toggle state visually
                button.classList.toggle('is-present');
                button.classList.toggle('is-absent');
                button.textContent = isCurrentlyPresent ? 'Mark Present' : 'Mark Absent';
            } else {
                showStatusMessage('Update failed.', 'error');
            }
            button.disabled = false;
        });
    });
}

// Generic modal open/close functions
function openModal(modalElement) {
    if (modalElement) {
        modalElement.style.display = 'block';
        document.body.classList.add('modal-open');
    }
}

function closeModal(modalElement) {
    if (modalElement) {
        modalElement.style.display = 'none';
        document.body.classList.remove('modal-open');
    }
}

// Add event listeners to all close buttons in all modals
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal); // Close if clicking on backdrop
    });
    modal.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', () => closeModal(modal));
    });
});