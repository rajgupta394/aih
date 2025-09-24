import os
import psycopg2
import psycopg2.extras
from datetime import datetime, timedelta, timezone
from flask import Flask, render_template, request, redirect, session, url_for, flash, jsonify, send_file
from functools import wraps
import secrets
import math
import io
import csv

app = Flask(__name__)
# Use a strong, consistent secret key from environment variables for production
app.secret_key = os.environ.get('SECRET_KEY', 'a_strong_default_secret_key_for_development')

# --- Application Configuration for AIH Department ---
CLASS_NAME = 'B.A. - AIH'
BATCH_CODE = 'BA' 
GEOFENCE_RADIUS = 50  # Radius in meters

# --- Controller Credentials (Use environment variables for production) ---
CONTROLLER_USERNAME = os.environ.get('AIH_CONTROLLER_USER', 'aih_controller')
CONTROLLER_PASSWORD = os.environ.get('AIH_CONTROLLER_PASS', 'aih_pass_123')

# --- Database Connection ---
DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    raise RuntimeError("FATAL: The DATABASE_URL environment variable is not set.")

def get_db_connection():
    """Establishes a reliable connection to the PostgreSQL database."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except psycopg2.OperationalError as e:
        print(f"FATAL: Database connection failed: {e}")
        return None

# --- Decorator for Controller-Only Routes ---
def controller_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session or session.get('role') != 'aih_controller':
            if request.path.startswith("/api/"):
                return jsonify({"success": False, "message": "Unauthorized"}), 401
            flash("You must be logged in as the AIH controller.", "warning")
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

# --- Helper Functions ---
def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi, delta_lambda = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def get_class_id_by_name(cursor):
    cursor.execute("SELECT id FROM classes WHERE class_name = 'BA - Anthropology'")
    result = cursor.fetchone()
    return result[0] if result else None

def get_controller_id_by_username(cursor):
    cursor.execute("SELECT id FROM users WHERE username = 'controller'")
    result = cursor.fetchone()
    return result[0] if result else None

# --- Main & Authentication Routes ---
@app.route('/')
def home():
    if 'user_id' in session and session.get('role') == 'aih_controller':
        return redirect(url_for('controller_dashboard'))
    return redirect(url_for('student_page'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username, password = request.form.get('username'), request.form.get('password')
        conn = get_db_connection()
        if not conn:
            flash("Database service unavailable.", "danger")
            return render_template('login.html', class_name=CLASS_NAME)
        try:
            with conn.cursor() as cur:
                if username == CONTROLLER_USERNAME and password == CONTROLLER_PASSWORD:
                    controller_id = get_controller_id_by_username(cur)
                    if controller_id:
                        session.clear()
                        session['user_id'] = controller_id
                        session['username'] = CONTROLLER_USERNAME
                        session['role'] = 'aih_controller'
                        return redirect(url_for('controller_dashboard'))
                    else:
                        flash("Controller user not configured in the database.", "danger")
                else:
                    flash("Invalid username or password.", "danger")
        finally:
            if conn: conn.close()
    return render_template('login.html', class_name=CLASS_NAME)

@app.route('/logout')
def logout():
    session.clear()
    flash("You have been successfully logged out.", "info")
    return redirect(url_for('login'))

# --- Student & Controller Views ---
@app.route('/student')
def student_page():
    active_session, present_students, geofence_data = None, None, None
    todays_date = datetime.now(timezone.utc).strftime('%A, %B %d, %Y')
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
                class_id = get_class_id_by_name(cur)
                if class_id:
                    cur.execute("""
                        SELECT id, end_time, geofence_lat, geofence_lon, geofence_radius FROM attendance_sessions 
                        WHERE class_id = %s AND is_active = TRUE AND end_time > NOW() AT TIME ZONE 'UTC' LIMIT 1
                    """, (class_id,))
                    session_data = cur.fetchone()
                    if session_data:
                        active_session = {'id': session_data['id'], 'end_time': session_data['end_time'].isoformat()}
                        geofence_data = { 'lat': session_data['geofence_lat'], 'lon': session_data['geofence_lon'], 'radius': session_data['geofence_radius'] }
                    else:
                        today_utc = datetime.now(timezone.utc).date()
                        cur.execute("""
                            SELECT DISTINCT s.name, s.enrollment_no FROM attendance_records ar
                            JOIN students s ON ar.student_id = s.id JOIN attendance_sessions ases ON ar.session_id = ases.id
                            WHERE ases.class_id = %s AND DATE(ases.start_time AT TIME ZONE 'UTC') = %s ORDER BY s.name ASC
                        """, (class_id, today_utc))
                        present_students = cur.fetchall()
        finally:
            if conn: conn.close()
    return render_template('student_attendance.html', active_session=active_session, present_students=present_students, class_name=CLASS_NAME, todays_date=todays_date, geofence_data=geofence_data)

@app.route('/controller_dashboard')
@controller_required
def controller_dashboard():
    active_session = None
    conn = get_db_connection()
    if conn:
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
                class_id = get_class_id_by_name(cur)
                if class_id:
                    cur.execute("SELECT id, end_time FROM attendance_sessions WHERE class_id = %s AND is_active = TRUE AND end_time > NOW() AT TIME ZONE 'UTC' LIMIT 1", (class_id,))
                    session_data = cur.fetchone()
                    if session_data:
                        active_session = {'id': session_data['id'], 'end_time': session_data['end_time'].isoformat()}
        finally:
            if conn: conn.close()
    return render_template('admin_dashboard.html', active_session=active_session, class_name=CLASS_NAME, username=session.get('username'))

@app.route('/attendance_report')
@controller_required
def attendance_report():
    conn = get_db_connection()
    if not conn:
        flash("Database connection failed.", "danger")
        return redirect(url_for('controller_dashboard'))
    
    report_data, students = [], []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            class_id = get_class_id_by_name(cur)
            cur.execute("SELECT id, name, enrollment_no FROM students WHERE batch = %s ORDER BY enrollment_no", (BATCH_CODE,))
            students = cur.fetchall()
            
            cur.execute("SELECT DISTINCT DATE(start_time AT TIME ZONE 'UTC') as class_date FROM attendance_sessions WHERE class_id = %s ORDER BY class_date DESC", (class_id,))
            class_dates = [row['class_date'] for row in cur.fetchall()]

            for class_date in class_dates:
                daily_entry = {'date': class_date.strftime('%Y-%m-%d'), 'students': []}
                cur.execute("SELECT DISTINCT student_id FROM attendance_records ar JOIN attendance_sessions s ON ar.session_id = s.id WHERE s.class_id = %s AND DATE(s.start_time AT TIME ZONE 'UTC') = %s", (class_id, class_date))
                present_ids = {row['student_id'] for row in cur.fetchall()}
                daily_entry['students'] = [{'status': 'Present' if student['id'] in present_ids else 'Absent'} for student in students]
                report_data.append(daily_entry)
    finally:
        if conn: conn.close()
    return render_template('attendance_report.html', report_data=report_data, students=students, class_name=CLASS_NAME)

# --- UPGRADED CSV EXPORT ---
@app.route('/export_csv')
@controller_required
def export_csv():
    csv_config = { 'school_name': 'AIH Dept.', 'course_title': 'AIH-DSM-311', 'professor_name': 'KRS Chandel' }
    conn = get_db_connection()
    if not conn:
        flash("Database connection failed.", "danger")
        return redirect(url_for('attendance_report'))
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            class_id = get_class_id_by_name(cur)
            
            cur.execute("SELECT MIN(start_time AT TIME ZONE 'UTC') as first_date FROM attendance_sessions WHERE class_id = %s", (class_id,))
            first_date_record = cur.fetchone()
            if not first_date_record or not first_date_record['first_date']:
                flash("No attendance data available to export.", "info")
                return redirect(url_for('attendance_report'))
            
            start_date = first_date_record['first_date'].date()
            end_date = datetime.now(timezone.utc).date()
            date_range = [start_date + timedelta(days=x) for x in range((end_date - start_date).days + 1)]

            cur.execute("SELECT id, name, enrollment_no FROM students WHERE batch = %s ORDER BY enrollment_no", (BATCH_CODE,))
            students = cur.fetchall()

            cur.execute("SELECT DISTINCT DATE(start_time AT TIME ZONE 'UTC') as session_date FROM attendance_sessions WHERE class_id = %s", (class_id,))
            session_days = {row['session_date'] for row in cur.fetchall()}
            total_working_days = len(session_days)

            cur.execute("SELECT ar.student_id, DATE(s.start_time AT TIME ZONE 'UTC') AS session_date FROM attendance_records ar JOIN attendance_sessions s ON ar.session_id = s.id WHERE s.class_id = %s", (class_id,))
            attendance_map = { (rec['student_id'], rec['session_date']): 'P' for rec in cur.fetchall() }
            
            output = io.StringIO()
            writer = csv.writer(output)
            
            writer.writerows([['School Name:', csv_config['school_name']], ['Course Title:', csv_config['course_title']], ['Professor Name:', csv_config['professor_name']], [], ['Key:'], ['P', 'Present'], ['A', 'Absent'], ['H', 'Holiday'], []])
            
            header = ['Student Name', 'ID Number'] + [d.strftime('%Y-%m-%d') for d in date_range] + ['Attendance %']
            writer.writerow(header)

            for student in students:
                present_count = 0
                row_data = []
                for date in date_range:
                    status = 'H'
                    if date in session_days:
                        if attendance_map.get((student['id'], date)) == 'P':
                            status = 'P'
                            present_count += 1
                        else:
                            status = 'A'
                    row_data.append(status)
                
                percentage = (present_count / total_working_days * 100) if total_working_days > 0 else 0
                percentage_str = f"{percentage:.1f}%"
                
                writer.writerow([student['name'], student['enrollment_no']] + row_data + [percentage_str])
            
            output.seek(0)
            file_name = f"AIH_Attendance_Report_{start_date}_to_{end_date}.csv"
            return send_file(io.BytesIO(output.getvalue().encode('utf-8')), mimetype='text/csv', as_attachment=True, download_name=file_name)
    finally:
        if conn: conn.close()


# --- API Endpoints ---

# NEW/UPDATED API Endpoint for live student list
@app.route('/api/get_present_students/<int:session_id>')
def api_get_present_students(session_id):
    conn = get_db_connection()
    if not conn: 
        return jsonify({"success": False, "students": []})
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT s.name, s.enrollment_no 
                FROM attendance_records ar
                JOIN students s ON ar.student_id = s.id
                WHERE ar.session_id = %s 
                ORDER BY s.name ASC
            """, (session_id,))
            students = [dict(row) for row in cur.fetchall()]
            return jsonify({"success": True, "students": students})
    except (Exception, psycopg2.Error) as e:
        print(f"Error in get_present_students: {e}")
        return jsonify({"success": False, "students": []})
    finally:
        if conn: conn.close()

@app.route('/api/mark_attendance', methods=['POST'])
def api_mark_attendance():
    data = request.form
    user_ip = request.headers.get('X-Forwarded-For', request.remote_addr).split(',')[0].strip()
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database service unavailable."}), 503

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("SELECT id, name FROM students WHERE enrollment_no = %s AND batch = %s", (data['enrollment_no'].strip().upper(), BATCH_CODE))
            student = cur.fetchone()
            if not student: return jsonify({"success": False, "message": "Enrollment number not found.", "category": "danger"}), 404

            cur.execute("SELECT ar.id FROM attendance_records ar JOIN attendance_sessions ases ON ar.session_id = ases.id WHERE ar.student_id = %s AND DATE(ases.start_time AT TIME ZONE 'UTC') = %s", (student['id'], datetime.now(timezone.utc).date()))
            if cur.fetchone():
                return jsonify({"success": False, "message": "You have already marked attendance today.", "category": "warning"}), 409

            cur.execute("SELECT id, geofence_lat, geofence_lon FROM attendance_sessions WHERE id = %s AND is_active = TRUE AND end_time > NOW() AT TIME ZONE 'UTC'", (data['session_id'],))
            session_info = cur.fetchone()
            if not session_info: return jsonify({"success": False, "message": "Attendance session has expired.", "category": "danger"}), 400

            distance = haversine_distance(float(data['latitude']), float(data['longitude']), session_info['geofence_lat'], session_info['geofence_lon'])
            if distance > GEOFENCE_RADIUS: return jsonify({"success": False, "message": f"You are {distance:.0f}m away. Move within {GEOFENCE_RADIUS}m.", "category": "danger"}), 403

            cur.execute("SELECT 1 FROM attendance_records WHERE session_id = %s AND ip_address = %s", (session_info['id'], user_ip))
            if cur.fetchone():
                return jsonify({"success": False, "message": "This network has already been used by another student.", "category": "danger"}), 403
            
            cur.execute("INSERT INTO attendance_records (session_id, student_id, timestamp, latitude, longitude, ip_address) VALUES (%s, %s, NOW() AT TIME ZONE 'UTC', %s, %s, %s)", (session_info['id'], student['id'], data['latitude'], data['longitude'], user_ip))
            conn.commit()
            return jsonify({"success": True, "message": f"{student['name']}, your attendance is marked!", "category": "success"})
    except (Exception, psycopg2.Error) as e:
        if conn: conn.rollback()
        print(f"ERROR in api_mark_attendance: {e}")
        return jsonify({"success": False, "message": "A server error occurred."}), 500
    finally:
        if conn: conn.close()

@app.route('/api/start_session', methods=['POST'])
@controller_required
def api_start_session():
    data = request.get_json()
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 503
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            class_id = get_class_id_by_name(cur)
            cur.execute("SELECT id FROM attendance_sessions WHERE class_id = %s AND is_active = TRUE AND end_time > NOW() AT TIME ZONE 'UTC'", (class_id,))
            if cur.fetchone():
                return jsonify({"success": False, "message": "An active session already exists."}), 409
            cur.execute("INSERT INTO attendance_sessions (class_id, controller_id, session_token, start_time, end_time, is_active, geofence_lat, geofence_lon, geofence_radius) VALUES (%s, %s, %s, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC' + interval '5 minutes', TRUE, %s, %s, %s) RETURNING id, end_time", (class_id, session['user_id'], secrets.token_hex(16), data['latitude'], data['longitude'], GEOFENCE_RADIUS))
            new_session = cur.fetchone()
            conn.commit()
            return jsonify({"success": True, "session": {'id': new_session['id'], 'end_time': new_session['end_time'].isoformat()}})
    finally:
        if conn: conn.close()

@app.route('/api/end_session/<int:session_id>', methods=['POST'])
@controller_required
def api_end_session(session_id):
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."})
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE attendance_sessions SET is_active = FALSE, end_time = NOW() AT TIME ZONE 'UTC' WHERE id = %s", (session_id,))
            conn.commit()
            return jsonify({"success": True, "message": "Session ended."})
    finally:
        if conn: conn.close()
        
@app.route('/api/get_student_name/<enrollment_no>')
def api_get_student_name(enrollment_no):
    conn = get_db_connection()
    if not conn: return jsonify({"success": False})
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM students WHERE enrollment_no = %s AND batch = %s", (enrollment_no.upper(), BATCH_CODE))
            result = cur.fetchone()
            return jsonify({"success": True, "name": result[0]}) if result else jsonify({"success": False})
    finally:
        if conn: conn.close()

@app.route('/api/get_students_for_day/<date_str>')
@controller_required
def api_get_students_for_day(date_str):
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 500
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            class_id = get_class_id_by_name(cur)
            day_to_query = datetime.strptime(date_str, '%Y-%m-%d').date()
            cur.execute("SELECT id, enrollment_no, name FROM students WHERE batch = %s ORDER BY enrollment_no", (BATCH_CODE,))
            all_students = cur.fetchall()
            cur.execute("SELECT DISTINCT ar.student_id FROM attendance_records ar JOIN attendance_sessions s ON ar.session_id = s.id WHERE s.class_id = %s AND DATE(s.start_time AT TIME ZONE 'UTC') = %s", (class_id, day_to_query))
            present_ids = {row['student_id'] for row in cur.fetchall()}
            student_data = [{'id': s['id'], 'enrollment_no': s['enrollment_no'], 'name': s['name'], 'is_present': s['id'] in present_ids} for s in all_students]
            return jsonify({"success": True, "students": student_data})
    finally:
        if conn: conn.close()

@app.route('/api/get_students_for_session/<int:session_id>')
@controller_required
def api_get_students_for_session(session_id):
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 500
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("SELECT id, enrollment_no, name FROM students WHERE batch = %s ORDER BY enrollment_no", (BATCH_CODE,))
            all_students = cur.fetchall()
            cur.execute("SELECT student_id FROM attendance_records WHERE session_id = %s", (session_id,))
            present_ids = {row['student_id'] for row in cur.fetchall()}
            student_data = [{'id': s['id'], 'enrollment_no': s['enrollment_no'], 'name': s['name'], 'is_present': s['id'] in present_ids} for s in all_students]
            return jsonify({"success": True, "students": student_data})
    finally:
        if conn: conn.close()

@app.route('/api/toggle_attendance_for_day', methods=['POST'])
@controller_required
def api_toggle_attendance_for_day():
    data = request.get_json()
    date_str, student_id, is_present = data.get('date'), data.get('student_id'), data.get('is_present')
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 500
    try:
        with conn.cursor() as cur:
            class_id = get_class_id_by_name(cur)
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            cur.execute("SELECT id FROM attendance_sessions WHERE class_id = %s AND DATE(start_time AT TIME ZONE 'UTC') = %s ORDER BY start_time", (class_id, target_date))
            session_ids = [row[0] for row in cur.fetchall()]
            if is_present:
                session_to_use = session_ids[0] if session_ids else None
                if not session_to_use:
                    start_of_day = datetime.combine(target_date, datetime.min.time(), tzinfo=timezone.utc)
                    cur.execute("INSERT INTO attendance_sessions (class_id, controller_id, session_token, start_time, end_time, is_active) VALUES (%s, %s, %s, %s, %s, FALSE) RETURNING id", (class_id, session['user_id'], f"manual-{secrets.token_hex(8)}", start_of_day, start_of_day))
                    session_to_use = cur.fetchone()[0]
                cur.execute("INSERT INTO attendance_records (session_id, student_id, timestamp, ip_address) VALUES (%s, %s, NOW() AT TIME ZONE 'UTC', 'Manual Edit') ON CONFLICT (session_id, student_id) DO NOTHING", (session_to_use, student_id))
            else:
                if session_ids:
                    cur.execute("DELETE FROM attendance_records WHERE student_id = %s AND session_id = ANY(%s)", (student_id, session_ids))
            conn.commit()
            return jsonify({"success": True})
    except (Exception, psycopg2.Error) as e:
        if conn: conn.rollback(); print(f"Error: {e}")
        return jsonify({"success": False, "message": "Server error."}), 500
    finally:
        if conn: conn.close()

@app.route('/api/toggle_attendance_for_session', methods=['POST'])
@controller_required
def api_toggle_attendance_for_session():
    data = request.get_json()
    session_id, student_id, is_present = data.get('session_id'), data.get('student_id'), data.get('is_present')
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 500
    try:
        with conn.cursor() as cur:
            if is_present:
                cur.execute("INSERT INTO attendance_records (session_id, student_id, timestamp, ip_address) VALUES (%s, %s, NOW() AT TIME ZONE 'UTC', 'Live Edit') ON CONFLICT (session_id, student_id) DO NOTHING", (session_id, student_id))
            else:
                cur.execute("DELETE FROM attendance_records WHERE session_id = %s AND student_id = %s", (session_id, student_id))
            conn.commit()
            return jsonify({"success": True})
    except (Exception, psycopg2.Error) as e:
        if conn: conn.rollback()
        return jsonify({"success": False, "message": "Server error."}), 500
    finally:
        if conn: conn.close()

@app.route('/api/delete_day/<date_str>', methods=['DELETE'])
@controller_required
def api_delete_day(date_str):
    conn = get_db_connection()
    if not conn: return jsonify({"success": False, "message": "Database error."}), 503
    try:
        with conn.cursor() as cur:
            class_id = get_class_id_by_name(cur)
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            cur.execute("SELECT id FROM attendance_sessions WHERE class_id = %s AND DATE(start_time AT TIME ZONE 'UTC') = %s", (class_id, target_date))
            session_ids = [row[0] for row in cur.fetchall()]
            if session_ids:
                cur.execute("DELETE FROM attendance_records WHERE session_id = ANY(%s)", (session_ids,))
                cur.execute("DELETE FROM attendance_sessions WHERE id = ANY(%s)", (session_ids,))
            conn.commit()
            return jsonify({"success": True, "message": f"All records for {date_str} deleted."})
    except (Exception, psycopg2.Error) as e:
        if conn: conn.rollback()
        return jsonify({"success": False, "message": "Server error during deletion."}), 500
    finally:
        if conn: conn.close()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'False').lower() in ['true', '1', 't']
    app.run(host='0.0.0.0', port=port, debug=debug)

