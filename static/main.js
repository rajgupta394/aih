/**
 * Frontend logic for the AIH Attendance System.
 * Focus on a professional, mobile-first, modal-driven UX.
 * Version with live student list and enhanced location fetching.
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
 * UPGRADED: A more precise and user-friendly geolocation function.
 * @param {function} successCallback Called with the final position object.
 * @param {function} errorCallback Called with a user-friendly error message.
 */
async function getAccurateLocation(successCallback, errorCallback) {
    const apiKey = window.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        errorCallback("Google Maps API key is missing.");
        return;
    }

    try {
        const response = await fetch(`https://www.googleapis.com/geolocation/v1/geolocate?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({}) // Sending an empty body for automatic location detection
        });

        const data = await response.json();

        if (response.ok) {
            const position = {
                coords: {
                    latitude: data.location.lat,
                    longitude: data.location.lng,
                    accuracy: data.accuracy // Use accuracy from API response
                }
            };
            // Log location for debugging
            console.log("Location obtained from Google Maps API:", position.coords);
            successCallback(position);
        } else {
            // Handle API-specific errors
            const errorMessage = data.error?.message || "An unknown error occurred with the Geolocation API.";
            errorCallback(errorMessage);
        }
    } catch (error) {
        // Handle network or fetch errors
        errorCallback("A network error occurred. Check your internet connection.");
    }
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
    if (document.querySelector('.student-card') || document.querySelector('.live-list-container')) initStudentPage();
    if (document.getElementById('start-session-btn') || document.querySelector('.end-session-btn')) initControllerDashboard();
    if (document.querySelector('.professional-table')) initReportPage();
});

function initStudentPage() {
    const attendanceForm = document.getElementById('attendance-form');
    const markButton = document.getElementById('mark-btn');
    const enrollmentInput = document.getElementById('enrollment_no');
    const spinner = document.getElementById('button-spinner');
    
    // NEW: Live list functionality
    const presentListElement = document.getElementById('present-students-list');
    let liveListInterval;

    const fetchPresentStudents = async (sessionId) => {
        if (!presentListElement) return;
        try {
            const response = await fetch(`/api/get_present_students/${sessionId}`);
            const data = await response.json();
            if (data.success && data.students) {
                if (data.students.length > 0) {
                    presentListElement.innerHTML = data.students.map(s => `<li>${s.name}</li>`).join('');
                } else {
                    presentListElement.innerHTML = '<li>No one has marked attendance yet.</li>';
                }
            }
        } catch (error) {
            console.error("Could not fetch present students:", error);
        }
    };

    if (window.activeSessionDataStudent?.id) {
        const sessionId = window.activeSessionDataStudent.id;
        const timerElement = document.getElementById('timer-student');
        startRobustTimer(window.activeSessionDataStudent.end_time, timerElement);
        
        // Fetch the list immediately, then start polling every 10 seconds
        fetchPresentStudents(sessionId);
        liveListInterval = setInterval(() => fetchPresentStudents(sessionId), 10000);
    }
    
    if (attendanceForm) {
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
            spinner.style.display = 'inline-block';
            markButton.querySelector('span').textContent = 'Getting Location...';
            document.getElementById('troubleshooting-tips').style.display = 'none';

            getAccurateLocation(
                async (position) => {
                    markButton.querySelector('span').textContent = 'Submitting...';
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
                        fetchPresentStudents(window.activeSessionDataStudent.id);
                    } else {
                        markButton.disabled = false;
                        spinner.style.display = 'none';
                        markButton.querySelector('span').textContent = 'Mark My Attendance';
                        if (result.message.includes("away")) {
                            document.getElementById('troubleshooting-tips').style.display = 'block';
                        }
                    }
                },
                (error) => {
                    showStatusMessage(error, 'error');
                    markButton.disabled = false;
                    spinner.style.display = 'none';
                    markButton.querySelector('span').textContent = 'Mark My Attendance';
                    document.getElementById('troubleshooting-tips').style.display = 'block';
                }
            );
        });
    }
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

    const deleteModal = document.getElementById('confirm-delete-modal');
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
                document.getElementById(`row-${dateToDelete}`).remove();
            }
            closeModal(deleteModal);
            confirmDeleteBtn.disabled = false;
        });
    }
}

function setupManagerModal(config) {
    const managerModal = document.getElementById('manager-modal');
    const studentListContainer = document.getElementById('student-list-container');
    const searchInput = document.getElementById('student-search-input');
    if(!managerModal) return;
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

document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
    });
    modal.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', () => closeModal(modal));
    });
});