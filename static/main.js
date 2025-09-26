/**
 * Frontend logic for the AIH Attendance System.
 * Implements a two-step location system and device fingerprinting for security.
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
    setTimeout(() => { statusDiv.style.display = 'none'; }, 6000);
}

/**
 * Generates a unique-ish fingerprint based on browser/device properties.
 * @returns {Promise<string>} A promise that resolves with a hashed fingerprint.
 */
async function getDeviceFingerprint() {
    const components = {
        userAgent: navigator.userAgent,
        screenWidth: screen.width,
        screenHeight: screen.height,
        colorDepth: screen.colorDepth,
        timezone: new Date().getTimezoneOffset(),
        language: navigator.language,
        platform: navigator.platform,
    };
    const jsonString = JSON.stringify(components);
    // Use the SubtleCrypto API to hash the string for a consistent, fixed-length fingerprint
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}


// --- LOCATION LOGIC ---

function getBrowserGpsLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            return reject("Geolocation is not supported by your browser.");
        }
        const options = { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 };
        navigator.geolocation.getCurrentPosition(
            (position) => resolve(position),
            (error) => {
                let message = "GPS Error: ";
                switch (error.code) {
                    case error.PERMISSION_DENIED: message += "Permission denied."; break;
                    case error.POSITION_UNAVAILABLE: message += "Position unavailable."; break;
                    case error.TIMEOUT: message += "Request timed out."; break;
                    default: message += "Unknown error.";
                }
                reject(message);
            },
            options
        );
    });
}

async function getGoogleApiLocation() {
    if (!window.GOOGLE_MAPS_API_KEY || window.GOOGLE_MAPS_API_KEY === "YOUR_GOOGLE_MAPS_API_KEY") {
        throw new Error("Configuration error: Google Maps API key is not set.");
    }
    const apiUrl = `https://www.googleapis.com/geolocation/v1/geolocate?key=${window.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`Google API responded with status ${response.status}`);
    const data = await response.json();
    if (data.location && data.accuracy) {
        return { coords: { latitude: data.location.lat, longitude: data.location.lng, accuracy: data.accuracy } };
    } else {
        throw new Error("Could not determine location from Google's response.");
    }
}

// --- OTHER UTILITIES ---

function startRobustTimer(endTimeIsoString, timerElement) {
    if (!endTimeIsoString || !timerElement) return;
    const endTime = new Date(endTimeIsoString).getTime();
    const timerInterval = setInterval(() => {
        const remaining = endTime - new Date().getTime();
        if (remaining <= 0) {
            clearInterval(timerInterval);
            timerElement.textContent = "Session Ended";
            if (document.body.contains(document.getElementById('attendance-form'))) window.location.reload();
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
    if (document.querySelector('.student-card') || document.querySelector('.live-list-container')) initStudentPage();
    if (document.getElementById('start-session-btn') || document.querySelector('.end-session-btn')) initControllerDashboard();
    if (document.querySelector('.professional-table')) initReportPage();
});

function initStudentPage() {
    const attendanceForm = document.getElementById('attendance-form');
    if (!attendanceForm) return;

    const markButton = document.getElementById('mark-btn');
    const enrollmentInput = document.getElementById('enrollment_no');
    const spinner = document.getElementById('button-spinner');
    const wifiModal = document.getElementById('wifi-prompt-modal');
    const retryWithGoogleBtn = document.getElementById('retry-with-google-btn');

    const fetchPresentStudents = async (sessionId) => {
        const presentListElement = document.getElementById('present-students-list');
        if (!presentListElement) return;
        try {
            const response = await fetch(`/api/get_present_students/${sessionId}`);
            const data = await response.json();
            if (data.success && data.students) {
                presentListElement.innerHTML = data.students.length > 0
                    ? data.students.map(s => `<li>${s.name}</li>`).join('')
                    : '<li>No one has marked attendance yet.</li>';
            }
        } catch (error) { console.error("Could not fetch present students:", error); }
    };

    if (window.activeSessionDataStudent?.id) {
        const sessionId = window.activeSessionDataStudent.id;
        startRobustTimer(window.activeSessionDataStudent.end_time, document.getElementById('timer-student'));
        fetchPresentStudents(sessionId);
        setInterval(() => fetchPresentStudents(sessionId), 10000);
    }
    
    enrollmentInput.addEventListener('input', debounce(async (e) => {
        const studentNameDisplay = document.getElementById('student-name-display');
        const enrollmentNo = e.target.value.trim();
        
        if (enrollmentNo.length >= 5) {
            studentNameDisplay.textContent = 'Searching...';
            studentNameDisplay.style.color = 'var(--text-muted)';
            const response = await fetch(`/api/get_student_name/${enrollmentNo}`);
            const data = await response.json();
            studentNameDisplay.textContent = data.name ? `Name: ${data.name}` : 'Student not found.';
            studentNameDisplay.style.color = data.name ? 'var(--primary-blue)' : 'var(--danger-red)';
        } else {
            studentNameDisplay.textContent = '';
        }
    }, 250));

    const resetSubmitButton = () => {
        markButton.disabled = false;
        spinner.style.display = 'none';
        markButton.querySelector('span').textContent = 'Mark My Attendance';
    };

    const handleAttendanceSubmission = async (position, method) => {
        // Generate the device fingerprint before submitting
        const fingerprint = await getDeviceFingerprint();

        const formData = new URLSearchParams({
            enrollment_no: enrollmentInput.value,
            session_id: window.activeSessionDataStudent.id,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            location_method: method,
            fingerprint: fingerprint // Include the fingerprint in the request
        });

        const response = await fetch('/api/mark_attendance', { method: 'POST', body: formData });
        const result = await response.json();

        if (result.success) {
            showStatusMessage(result.message, result.category);
            attendanceForm.style.display = 'none';
            fetchPresentStudents(window.activeSessionDataStudent.id);
        } else if (result.category === 'retry_high_accuracy') {
            showStatusMessage(result.message, 'info');
            openModal(wifiModal);
        } else {
            showStatusMessage(result.message, result.category);
            resetSubmitButton();
            if (result.message.includes("away")) {
                document.getElementById('troubleshooting-tips').style.display = 'block';
            }
        }
    };

    attendanceForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        markButton.disabled = true;
        spinner.style.display = 'inline-block';
        markButton.querySelector('span').textContent = 'Getting GPS Location...';
        document.getElementById('troubleshooting-tips').style.display = 'none';

        try {
            const gpsPosition = await getBrowserGpsLocation();
            await handleAttendanceSubmission(gpsPosition, 'gps');
        } catch (gpsError) {
            console.warn("Initial GPS failed:", gpsError);
            showStatusMessage("GPS failed. Please enable Wi-Fi for a more precise check.", "info");
            openModal(wifiModal);
            // Don't reset the button here, let the modal action handle it.
        }
    });
    
    retryWithGoogleBtn.addEventListener('click', async () => {
        closeModal(wifiModal);
        markButton.querySelector('span').textContent = 'Getting Wi-Fi Location...';
        try {
            const googlePosition = await getGoogleApiLocation();
            await handleAttendanceSubmission(googlePosition, 'google');
        } catch (googleError) {
            showStatusMessage("Advanced location check failed. Please check your connection.", "error");
            document.getElementById('troubleshooting-tips').style.display = 'block';
            resetSubmitButton();
        }
    });
}

function initControllerDashboard() {
    const startButton = document.getElementById('start-session-btn');
    const endButton = document.querySelector('.end-session-btn');
    const liveManagerBtn = document.getElementById('live-manager-btn');

    if (window.activeSessionData?.id) {
        startRobustTimer(window.activeSessionData.end_time, document.getElementById(`timer-${window.activeSessionData.id}`));
    }

    if (startButton) {
        startButton.addEventListener('click', async () => {
            startButton.disabled = true;
            startButton.textContent = 'Starting Session...';
            
            // No need for location check here as it's not used in the final backend logic for starting a session
            const response = await fetch('/api/start_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}), // Empty body is fine
            });

            const result = await response.json();
            if (result.success) {
                window.location.reload();
            } else {
                showStatusMessage(result.message, 'error');
                startButton.disabled = false;
                startButton.textContent = 'Start New Session';
            }
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
            setupManagerModal({
                title: "Live Attendance Manager",
                subtitle: `Session ID: ${liveManagerBtn.dataset.sessionId}`,
                fetchUrl: `/api/get_students_for_session/${liveManagerBtn.dataset.sessionId}`,
                apiUrl: '/api/toggle_attendance_for_session',
                payload: { session_id: liveManagerBtn.dataset.sessionId }
            });
        });
    }
}

function initReportPage() {
    document.querySelectorAll('.edit-day-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            setupManagerModal({
                title: "Edit Attendance",
                subtitle: `Date: ${e.target.dataset.date}`,
                fetchUrl: `/api/get_students_for_day/${e.target.dataset.date}`,
                apiUrl: '/api/toggle_attendance_for_day',
                payload: { date: e.target.dataset.date }
            });
        });
    });

    const deleteModal = document.getElementById('confirm-delete-modal');
    if (!deleteModal) return;

    const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
    const deleteDateDisplay = document.getElementById('modal-delete-date-display');
    let dateToDelete = null;

    document.querySelectorAll('.delete-day-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            dateToDelete = e.target.dataset.date;
            deleteDateDisplay.textContent = dateToDelete;
            openModal(deleteModal);
        });
    });

    if(confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async () => {
            if (!dateToDelete) return;
            confirmDeleteBtn.disabled = true;
            const response = await fetch(`/api/delete_day/${dateToDelete}`, { method: 'DELETE' });
            const result = await response.json();
            showStatusMessage(result.message, result.success ? 'success' : 'error');
            if (result.success) {
                const row = document.getElementById(`row-${dateToDelete}`);
                if (row) row.remove();
            }
            closeModal(deleteModal);
            confirmDeleteBtn.disabled = false;
        });
    }
}

function setupManagerModal(config) {
    const managerModal = document.getElementById('manager-modal');
    if(!managerModal) return;
    const studentListContainer = managerModal.querySelector('#student-list-container');
    const searchInput = managerModal.querySelector('#student-search-input');
    
    managerModal.querySelector('#modal-title').textContent = config.title;
    managerModal.querySelector('#modal-subtitle').textContent = config.subtitle;
    studentListContainer.innerHTML = '<p style="text-align:center;">Loading students...</p>';
    openModal(managerModal);
    
    fetch(config.fetchUrl)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                renderStudentList(data.students, config, studentListContainer);
                if(searchInput) {
                    searchInput.oninput = () => renderStudentList(data.students.filter(s => 
                        s.name.toLowerCase().includes(searchInput.value.toLowerCase()) || 
                        s.enrollment_no.toLowerCase().includes(searchInput.value.toLowerCase())
                    ), config, studentListContainer);
                }
            } else {
                studentListContainer.innerHTML = `<p class="error">${data.message}</p>`;
            }
        });
}

function renderStudentList(students, config, container) {
    container.innerHTML = '';
    if (students.length === 0) {
        container.innerHTML = '<p style="text-align:center;">No students match your search.</p>';
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
        container.appendChild(item);
    });

    container.querySelectorAll('.attendance-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const button = e.target.closest('button');
            const studentId = button.dataset.studentId;
            const isCurrentlyPresent = button.classList.contains('is-present');
            button.disabled = true;
            const response = await fetch(config.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...config.payload, student_id: studentId, is_present: !isCurrentlyPresent })
            });
            const result = await response.json();
            if (result.success) {
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

function openModal(modalElement) {
    if (modalElement) modalElement.style.display = 'block';
    document.body.classList.add('modal-open');
}

function closeModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    document.body.classList.remove('modal-open');
}

document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
    });
    modal.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', () => closeModal(modal));
    });
});

