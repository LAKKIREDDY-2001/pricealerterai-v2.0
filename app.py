import os
import re
import sqlite3
import random
import string
import json
import secrets
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, session, redirect, url_for, render_template, send_from_directory, has_request_context
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import smtplib

app = Flask(__name__)
executor = ThreadPoolExecutor(max_workers=3)
# Use stable secret key in production (set SECRET_KEY env var), fallback for local.
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24))
is_production = os.environ.get('APP_ENV', '').lower() == 'production'
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = is_production
app.config['SESSION_COOKIE_HTTPONLY'] = True
CORS(app, supports_credentials=True, origins="*")

DATABASE = 'database.db'

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"}), 200

# Email Configuration
def load_email_config():
    config = {
        'enabled': False,
        'smtp_server': 'smtp.gmail.com',
        'smtp_port': 587,
        'smtp_email': '',
        'smtp_password': '',
        'from_name': 'AI Price Alert',
        'provider': 'gmail'
    }
    config_file = 'email_config.json'
    if os.path.exists(config_file):
        try:
            with open(config_file, 'r') as f:
                file_config = json.load(f)
                config.update(file_config)
        except Exception as e:
            print(f"Error loading email config: {e}")
    if os.environ.get('SMTP_ENABLED'):
        config['enabled'] = os.environ.get('SMTP_ENABLED').lower() == 'true'
    if os.environ.get('SMTP_SERVER'):
        config['smtp_server'] = os.environ.get('SMTP_SERVER')
    if os.environ.get('SMTP_PORT'):
        config['smtp_port'] = int(os.environ.get('SMTP_PORT'))
    if os.environ.get('SMTP_EMAIL'):
        config['smtp_email'] = os.environ.get('SMTP_EMAIL')
    if os.environ.get('SMTP_PASSWORD'):
        config['smtp_password'] = os.environ.get('SMTP_PASSWORD')
    if os.environ.get('SMTP_FROM_NAME'):
        config['from_name'] = os.environ.get('SMTP_FROM_NAME')
    if os.environ.get('HOST_URL'):
        config['host_url'] = os.environ.get('HOST_URL')
    return config

EMAIL_CONFIG = load_email_config()

# Load other configs
def load_json_config(filename, defaults):
    config = defaults.copy()
    if os.path.exists(filename):
        try:
            with open(filename, 'r') as f:
                file_config = json.load(f)
                config.update(file_config)
        except Exception as e:
            print(f"Error loading {filename}: {e}")
    return config

TWILIO_CONFIG = load_json_config('twilio_config.json', {
    'enabled': False, 'account_sid': '', 'auth_token': '', 'phone_number': ''
})

TELEGRAM_CONFIG = load_json_config('telegram_config.json', {
    'enabled': False, 'bot_token': '', 'webhook_url': '', 'bot_username': ''
})

WHATSAPP_CONFIG = load_json_config('whatsapp_config.json', {
    'enabled': False, 'twilio_account_sid': '', 'twilio_auth_token': '',
    'twilio_whatsapp_number': '+14155238886', 'from_name': 'AI Price Alert'
})

# ==================== EMAIL FUNCTIONS ====================

def send_mail(to_email, subject, html_body, text_body=None):
    if not EMAIL_CONFIG['enabled']:
        print(f"\n{'='*60}")
        print("📧 EMAIL SENT - DEMO MODE")
        print(f"{'='*60}")
        print(f"To: {to_email}")
        print(f"Subject: {subject}")
        print(f"{'='*60}\n")
        return True
    
    if not EMAIL_CONFIG.get('smtp_email') or not EMAIL_CONFIG.get('smtp_password'):
        print(f"Email not configured - skipping send to {to_email}")
        return False
    
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = f"{EMAIL_CONFIG['from_name']} <{EMAIL_CONFIG['smtp_email']}>"
        msg['To'] = to_email
        if text_body:
            text_part = MIMEText(text_body, 'plain')
            msg.attach(text_part)
        html_part = MIMEText(html_body, 'html')
        msg.attach(html_part)
        smtp_port = EMAIL_CONFIG.get('smtp_port', 587)
        use_tls = EMAIL_CONFIG.get('use_tls', True)
        if use_tls:
            with smtplib.SMTP(EMAIL_CONFIG['smtp_server'], smtp_port, timeout=30) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(EMAIL_CONFIG['smtp_email'], EMAIL_CONFIG['smtp_password'])
                server.send_message(msg)
        else:
            with smtplib.SMTP_SSL(EMAIL_CONFIG['smtp_server'], smtp_port, timeout=30) as server:
                server.login(EMAIL_CONFIG['smtp_email'], EMAIL_CONFIG['smtp_password'])
                server.send_message(msg)
        print(f"✓ Email sent successfully to {to_email}")
        return True
    except Exception as e:
        print(f"✗ Error sending email to {to_email}: {e}")
        return False

def generate_otp():
    return ''.join(random.choices(string.digits, k=6))

def send_email_otp(email, otp, purpose="verification"):
    if EMAIL_CONFIG['enabled']:
        try:
            msg = MIMEText(f'Your AI Price Alert {purpose} code is: {otp}\n\nThis code expires in 10 minutes.')
            msg['Subject'] = f'AI Price Alert - {purpose.title()} Code'
            msg['From'] = f"{EMAIL_CONFIG['from_name']} <{EMAIL_CONFIG['smtp_email']}>"
            msg['To'] = email
            with smtplib.SMTP(EMAIL_CONFIG['smtp_server'], EMAIL_CONFIG['smtp_port'], timeout=30) as server:
                server.starttls()
                server.login(EMAIL_CONFIG['smtp_email'], EMAIL_CONFIG['smtp_password'])
                server.send_message(msg)
            return True
        except Exception as e:
            print(f"Email send error: {e}")
            return False
    else:
        print(f"\n{'='*50}")
        print(f"📧 EMAIL OTP ({purpose.upper()}) - DEMO MODE")
        print(f"{'='*50}")
        print(f"To: {email}")
        print(f"OTP: {otp}")
        print(f"{'='*50}\n")
        return True

def send_password_reset_email(email, reset_token):
    host_url = str(EMAIL_CONFIG.get('host_url', '')).strip()
    if not host_url and has_request_context():
        host_url = request.url_root.rstrip('/')
    if not host_url:
        host_url = 'https://pricealerter.in'
    reset_link = f"{host_url}/reset-password?token={reset_token}"
    email_content = f'''
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Password Reset</title></head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #1a1a2e;">Password Reset Request</h1>
        <p>You requested to reset your password for AI Price Alert.</p>
        <p>Click the button below to reset your password:</p>
        <a href="{reset_link}" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Reset Password</a>
        <p style="color: #666; margin-top: 20px;">This link expires in 30 minutes.</p>
    </body>
    </html>
    '''
    return send_mail(to_email=email, subject='AI Price Alert - Password Reset', html_body=email_content)

# ==================== DATABASE ====================

def init_db():
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            phone TEXT,
            email_verified INTEGER DEFAULT 0,
            phone_verified INTEGER DEFAULT 0,
            two_factor_enabled INTEGER DEFAULT 0,
            two_factor_method TEXT DEFAULT 'none',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS otp_verification (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            email TEXT,
            phone TEXT,
            email_otp TEXT,
            phone_otp TEXT,
            email_otp_expiry TIMESTAMP,
            phone_otp_expiry TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reset_token TEXT NOT NULL UNIQUE,
            reset_token_expiry TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS pending_signups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signup_token TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL,
            email TEXT NOT NULL,
            password TEXT NOT NULL,
            phone TEXT,
            email_otp TEXT,
            email_otp_expiry TIMESTAMP,
            phone_otp TEXT,
            phone_otp_expiry TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trackers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            product_name TEXT,
            current_price REAL NOT NULL,
            target_price REAL NOT NULL,
            currency TEXT,
            currency_symbol TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    
    conn.commit()
    conn.close()

# ==================== ROUTES ====================

@app.route('/')
def root():
    """Home page with SEO content"""
    return render_template('home.html')

@app.route('/home')
def home():
    """Home page redirect"""
    return render_template('home.html')

@app.route('/about')
def about():
    """About page with SEO content"""
    return render_template('about.html')

@app.route('/contact')
def contact():
    """Contact page with SEO content"""
    return render_template('contact.html')

@app.route('/privacy')
def privacy():
    """Privacy policy page with SEO content"""
    return render_template('privacy.html')

@app.route('/terms')
def terms():
    """Terms of service page with SEO content"""
    return render_template('terms.html')

@app.route('/blog')
def blog():
    """Blog listing page"""
    return render_template('blog.html')

@app.route('/blog/how-to-track-product-prices-online')
def blog_track_prices():
    """Blog post 1 slug - currently routed to blog listing."""
    return redirect(url_for('blog'))

@app.route('/blog/best-price-alert-tools-india')
def blog_best_tools():
    """Blog post 2 slug - currently routed to blog listing."""
    return redirect(url_for('blog'))

@app.route('/blog/save-money-price-trackers')
def blog_save_money():
    """Blog post 3 slug - currently routed to blog listing."""
    return redirect(url_for('blog'))

@app.route('/blog/amazon-price-history')
def blog_amazon_history():
    """Blog post 4 slug - currently routed to blog listing."""
    return redirect(url_for('blog'))

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    """Signup page - redirect to dashboard if already logged in"""
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    
    if request.method == 'POST':
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid request body"}), 400
        username = data.get('username')
        email = data.get('email')
        password = data.get('password')
        phone = data.get('phone')

        if not all([username, email, password]):
            return jsonify({"error": "Missing data"}), 400

        try:
            conn = sqlite3.connect(DATABASE)
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
            if cursor.fetchone():
                conn.close()
                return jsonify({"error": "Email already exists"}), 409

            cursor.execute("""
                INSERT INTO users (username, email, password, phone, email_verified)
                VALUES (?, ?, ?, ?, ?)
            """, (username, email, generate_password_hash(password), phone, 1))
            conn.commit()
            conn.close()

            return jsonify({
                "success": "Account created successfully",
                "redirect": "/login"
            }), 200
        except Exception:
            return jsonify({"error": "Signup failed. Please try again."}), 500

    return render_template('signup.html')

@app.route('/api/signup-complete', methods=['POST'])
def signup_complete():
    """Complete signup after OTP verification"""
    data = request.get_json()
    signup_token = data.get('signupToken')
    email_otp = data.get('emailOTP', '')
    
    if not signup_token:
        return jsonify({"error": "Signup token is required"}), 400
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM pending_signups WHERE signup_token = ?", (signup_token,))
    pending = cursor.fetchone()
    
    if not pending:
        conn.close()
        return jsonify({"error": "Invalid or expired signup session. Please start over."}), 400
    
    signup_id, stored_token, username, email, password, phone, stored_email_otp, stored_email_otp_expiry, stored_phone_otp, stored_phone_otp_expiry, created_at = pending
    
    # SQLite CURRENT_TIMESTAMP is UTC; compare in UTC to avoid timezone false-expiry.
    expiry = datetime.fromisoformat(created_at) + timedelta(minutes=30)
    if datetime.utcnow() > expiry:
        cursor.execute("DELETE FROM pending_signups WHERE id = ?", (signup_id,))
        conn.commit()
        conn.close()
        return jsonify({"error": "Signup session expired. Please start over."}), 400
    
    # Verify email OTP
    email_verified = False
    if email_otp:
        if stored_email_otp and stored_email_otp == email_otp:
            if stored_email_otp_expiry:
                otp_expiry = datetime.fromisoformat(stored_email_otp_expiry)
                if datetime.now() > otp_expiry:
                    conn.close()
                    return jsonify({"error": "Email OTP has expired"}), 400
            email_verified = True
        else:
            conn.close()
            return jsonify({"error": "Invalid email OTP"}), 400
    
    if not email_verified:
        conn.close()
        return jsonify({"error": "Email verification is required", "requiresEmailVerification": True}), 400
    
    # Create the account
    try:
        cursor.execute("""
            INSERT INTO users (username, email, password, phone, email_verified)
            VALUES (?, ?, ?, ?, ?)
        """, (username, email, password, phone, 1))
        user_id = cursor.lastrowid
        
        cursor.execute("""
            INSERT INTO otp_verification (user_id, email, phone)
            VALUES (?, ?, ?)
        """, (user_id, email, phone))
        
        cursor.execute("DELETE FROM pending_signups WHERE id = ?", (signup_id,))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"error": "Email already exists"}), 409
    finally:
        conn.close()
    
    return jsonify({
        "success": "Account created successfully!",
        "userId": user_id,
        "message": "Redirecting to login..."
    }), 201

@app.route('/api/send-email-otp', methods=['POST'])
def api_send_email_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    purpose = (data.get('purpose') or 'verification').strip()
    signup_token = data.get('signupToken')

    if not email:
        return jsonify({"error": "Email is required"}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    if signup_token:
        cursor.execute(
            "SELECT id, email FROM pending_signups WHERE signup_token = ?",
            (signup_token,)
        )
    else:
        cursor.execute(
            "SELECT id, email FROM pending_signups WHERE email = ? ORDER BY id DESC LIMIT 1",
            (email,)
        )
    pending = cursor.fetchone()
    if not pending:
        conn.close()
        return jsonify({"error": "No pending signup found. Please sign up again."}), 404

    pending_id, pending_email = pending
    otp = generate_otp()
    expiry = (datetime.now() + timedelta(minutes=10)).isoformat()
    cursor.execute(
        "UPDATE pending_signups SET email_otp = ?, email_otp_expiry = ? WHERE id = ?",
        (otp, expiry, pending_id)
    )
    conn.commit()
    conn.close()

    if not send_email_otp(pending_email, otp, purpose):
        # Keep flow working even if SMTP is not configured; OTP is already stored.
        print(f"EMAIL OTP ({pending_email}): {otp}")
        return jsonify({"success": True, "message": "OTP generated (demo mode)"}), 200
    return jsonify({"success": True, "message": "Email OTP sent"}), 200

@app.route('/api/verify-email-otp', methods=['POST'])
def api_verify_email_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    otp = (data.get('otp') or '').strip()
    if not email or not otp:
        return jsonify({"error": "Email and OTP are required"}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT email_otp, email_otp_expiry
        FROM pending_signups
        WHERE email = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (email,)
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "No pending signup found"}), 404

    stored_otp, otp_expiry = row
    if not stored_otp or stored_otp != otp:
        return jsonify({"error": "Invalid email OTP"}), 400
    if otp_expiry and datetime.now() > datetime.fromisoformat(otp_expiry):
        return jsonify({"error": "Email OTP has expired"}), 400
    return jsonify({"success": True, "verified": True, "message": "Email verified"}), 200

@app.route('/api/send-phone-otp', methods=['POST'])
def api_send_phone_otp():
    data = request.get_json(silent=True) or {}
    phone = (data.get('phone') or '').strip()
    signup_token = data.get('signupToken')
    if not phone:
        return jsonify({"error": "Phone number is required"}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    if signup_token:
        cursor.execute(
            "SELECT id, phone FROM pending_signups WHERE signup_token = ?",
            (signup_token,)
        )
    else:
        cursor.execute(
            "SELECT id, phone FROM pending_signups WHERE phone = ? ORDER BY id DESC LIMIT 1",
            (phone,)
        )
    pending = cursor.fetchone()
    if not pending:
        conn.close()
        return jsonify({"error": "No pending signup found. Please sign up again."}), 404

    pending_id, pending_phone = pending
    otp = generate_otp()
    expiry = (datetime.now() + timedelta(minutes=10)).isoformat()
    cursor.execute(
        "UPDATE pending_signups SET phone_otp = ?, phone_otp_expiry = ? WHERE id = ?",
        (otp, expiry, pending_id)
    )
    conn.commit()
    conn.close()

    # Demo mode: print OTP in server logs until SMS provider is configured.
    print(f"PHONE OTP ({pending_phone}): {otp}")
    return jsonify({"success": True, "message": "Phone OTP sent"}), 200

@app.route('/api/verify-phone-otp', methods=['POST'])
def api_verify_phone_otp():
    data = request.get_json(silent=True) or {}
    phone = (data.get('phone') or '').strip()
    otp = (data.get('otp') or '').strip()
    if not phone or not otp:
        return jsonify({"error": "Phone and OTP are required"}), 400

    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT phone_otp, phone_otp_expiry
        FROM pending_signups
        WHERE phone = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (phone,)
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "No pending signup found"}), 404

    stored_otp, otp_expiry = row
    if not stored_otp or stored_otp != otp:
        return jsonify({"error": "Invalid phone OTP"}), 400
    if otp_expiry and datetime.now() > datetime.fromisoformat(otp_expiry):
        return jsonify({"error": "Phone OTP has expired"}), 400
    return jsonify({"success": True, "verified": True, "message": "Phone verified"}), 200

@app.route('/login', methods=['GET', 'POST'])
def login():
    """Login page - redirect to dashboard if already logged in"""
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    
    if request.method == 'POST':
        data = request.get_json(silent=True) or {}
        email = data.get('email')
        password = data.get('password')

        if not email or not password:
            return jsonify({"error": "Missing data"}), 400
        
        try:
            conn = sqlite3.connect(DATABASE)
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
            user = cursor.fetchone()
            conn.close()

            if user and check_password_hash(user[3], password):
                session['user_id'] = user[0]
                return jsonify({
                    "success": "Logged in successfully",
                    "redirect": "/dashboard"
                }), 200
            else:
                return jsonify({"error": "Invalid credentials"}), 401
        except Exception:
            return jsonify({"error": "Login failed. Please try again."}), 500
    
    return render_template('login.html')

@app.route('/dashboard')
def dashboard():
    """Dashboard - requires login"""
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return render_template('index.html')

@app.route('/logout')
def logout():
    session.pop('user_id', None)
    return redirect(url_for('home'))

@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if request.method == 'POST':
        data = request.get_json()
        email = data.get('email')
        if not email:
            return jsonify({"error": "Email is required"}), 400
        
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
        user = cursor.fetchone()
        conn.close()
        
        if user:
            reset_token = secrets.token_urlsafe(32)
            expiry = datetime.now() + timedelta(minutes=30)
            conn = sqlite3.connect(DATABASE)
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO password_resets (user_id, reset_token, reset_token_expiry)
                VALUES (?, ?, ?)
            """, (user[0], reset_token, expiry.isoformat()))
            conn.commit()
            conn.close()
            return jsonify({
                "success": True,
                "message": "Reset link generated",
                "reset_link": f"/reset-password?token={reset_token}"
            }), 200
        return jsonify({"error": "No account found for this email"}), 404
        
        return jsonify({"error": "Unable to process request"}), 500
    
    return render_template('forgot-password.html')

@app.route('/reset-password', methods=['GET', 'POST'])
def reset_password():
    token = request.args.get('token')
    if not token:
        return render_template('error.html', error="Invalid reset link")
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT user_id, reset_token_expiry FROM password_resets WHERE reset_token = ?", (token,))
    reset_record = cursor.fetchone()
    
    if not reset_record:
        conn.close()
        return render_template('error.html', error="Invalid or expired reset link")
    
    expiry = datetime.fromisoformat(reset_record[1]) if reset_record[1] else None
    if expiry and datetime.now() > expiry:
        conn.close()
        return render_template('error.html', error="Reset link has expired")
    
    user_id = reset_record[0]
    
    if request.method == 'POST':
        data = request.get_json()
        new_password = data.get('password')
        if not new_password or len(new_password) < 6:
            return jsonify({"error": "Password must be at least 6 characters"}), 400
        
        hashed = generate_password_hash(new_password)
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET password = ? WHERE id = ?", (hashed, user_id))
        cursor.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()
        return jsonify({"success": True, "message": "Password reset successful"}), 200
    
    conn.close()
    return render_template('reset-password.html', token=token)

@app.route('/error')
def error_page():
    error = request.args.get('error', 'An unexpected error occurred')
    return render_template('error.html', error=error)

# ==================== API ROUTES ====================

@app.route('/api/user', methods=['GET'])
def get_user():
    if 'user_id' not in session:
        return jsonify({"error": "Not logged in"}), 401
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, email, phone FROM users WHERE id = ?", (session['user_id'],))
    user = cursor.fetchone()
    conn.close()
    
    if user:
        return jsonify({"id": user[0], "username": user[1], "email": user[2], "phone": user[3]})
    return jsonify({"error": "User not found"}), 404

@app.route('/api/feedback', methods=['POST'])
def api_feedback():
    data = request.get_json(silent=True) or {}
    message = (data.get('message') or '').strip()
    feedback_type = (data.get('type') or 'general').strip()
    source = (data.get('source') or 'web').strip()
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip()

    if not message:
        return jsonify({"error": "Feedback message is required"}), 400

    # Fill missing sender details from current session user.
    if 'user_id' in session and (not name or not email):
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("SELECT username, email FROM users WHERE id = ?", (session['user_id'],))
        row = cursor.fetchone()
        conn.close()
        if row:
            name = name or (row[0] or '')
            email = email or (row[1] or '')

    # Always route customer feedback to your support inbox.
    to_email = 'pricealerterai@gmail.com'
    subject = f"AI Price Alert Feedback [{feedback_type}]"
    html_body = f"""
    <h2>New Feedback Received</h2>
    <p><strong>Type:</strong> {feedback_type}</p>
    <p><strong>Source:</strong> {source}</p>
    <p><strong>Name:</strong> {name or 'Anonymous'}</p>
    <p><strong>Email:</strong> {email or 'Not provided'}</p>
    <p><strong>Message:</strong></p>
    <pre style=\"white-space: pre-wrap; font-family: Arial, sans-serif;\">{message}</pre>
    """
    text_body = (
        f"Type: {feedback_type}\n"
        f"Source: {source}\n"
        f"Name: {name or 'Anonymous'}\n"
        f"Email: {email or 'Not provided'}\n\n"
        f"Message:\n{message}\n"
    )

    sent = send_mail(to_email=to_email, subject=subject, html_body=html_body, text_body=text_body)
    if not sent:
        # Fallback so customer flow does not break if SMTP credentials are missing.
        try:
            with open('feedback_fallback.log', 'a') as f:
                f.write(f"{datetime.now().isoformat()} | {feedback_type} | {source} | {name} | {email}\n{message}\n---\n")
        except Exception:
            pass
        return jsonify({
            "success": True,
            "message": "Feedback captured. Configure SMTP app password to deliver emails directly."
        }), 200
    return jsonify({"success": True, "message": "Feedback sent successfully"}), 200

@app.route('/api/trackers', methods=['GET', 'POST', 'DELETE', 'PUT'])
def trackers():
    if 'user_id' not in session:
        return jsonify({"error": "Not logged in"}), 401
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    
    if request.method == 'GET':
        cursor.execute("SELECT id, url, product_name, current_price, target_price, currency, currency_symbol, created_at FROM trackers WHERE user_id = ? ORDER BY created_at DESC", (session['user_id'],))
        trackers_list = cursor.fetchall()
        conn.close()
        result = []
        for t in trackers_list:
            result.append({
                "id": t[0], "url": t[1], "productName": t[2] or "Product",
                "currentPrice": t[3], "targetPrice": t[4],
                "currency": t[5], "currencySymbol": t[6], "createdAt": t[7]
            })
        return jsonify(result)
    
    if request.method == 'POST':
        data = request.json
        cursor.execute("""
            INSERT INTO trackers (user_id, url, product_name, current_price, target_price, currency, currency_symbol)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (session['user_id'], data.get('url'), data.get('productName'), 
              data.get('currentPrice'), data.get('targetPrice'), 
              data.get('currency', 'USD'), data.get('currencySymbol', '$')))
        tracker_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return jsonify({"id": tracker_id, "message": "Tracker created"}), 201
    
    if request.method == 'DELETE':
        data = request.json
        tracker_id = data.get('id')
        cursor.execute("DELETE FROM trackers WHERE id = ? AND user_id = ?", (tracker_id, session['user_id']))
        conn.commit()
        conn.close()
        return jsonify({"message": "Tracker deleted"})

    if request.method == 'PUT':
        data = request.json or {}
        tracker_id = data.get('id')
        if not tracker_id:
            conn.close()
            return jsonify({"error": "Tracker id is required"}), 400

        cursor.execute("""
            UPDATE trackers
            SET current_price = ?, product_name = ?, currency = ?, currency_symbol = ?
            WHERE id = ? AND user_id = ?
        """, (
            data.get('currentPrice'),
            data.get('productName'),
            data.get('currency', 'USD'),
            data.get('currencySymbol', '$'),
            tracker_id,
            session['user_id']
        ))
        conn.commit()
        updated_rows = cursor.rowcount
        conn.close()
        if updated_rows == 0:
            return jsonify({"error": "Tracker not found"}), 404
        return jsonify({"message": "Tracker updated"})

# ==================== PASSWORD RESET API ROUTES ====================

@app.route('/api/forgot-password', methods=['POST'])
def api_forgot_password():
    """API endpoint for forgot password - handles JSON requests"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid request"}), 400
    
    email = data.get('email')
    if not email:
        return jsonify({"error": "Email is required"}), 400
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE email = ?", (email,))
    user = cursor.fetchone()
    conn.close()
    
    if user:
        reset_token = secrets.token_urlsafe(32)
        expiry = datetime.now() + timedelta(minutes=30)
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO password_resets (user_id, reset_token, reset_token_expiry)
            VALUES (?, ?, ?)
        """, (user[0], reset_token, expiry.isoformat()))
        conn.commit()
        conn.close()
        return jsonify({
            "success": True,
            "message": "Reset link generated",
            "reset_link": f"/reset-password?token={reset_token}"
        }), 200
    
    return jsonify({"error": "No account found for this email"}), 404

@app.route('/api/reset-password', methods=['POST'])
def api_reset_password():
    """API endpoint for reset password - handles JSON requests"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid request"}), 400
    
    token = data.get('token')
    password = data.get('password')
    
    if not token:
        return jsonify({"error": "Token is required"}), 400
    
    if not password or len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute("SELECT user_id, reset_token_expiry FROM password_resets WHERE reset_token = ?", (token,))
    reset_record = cursor.fetchone()
    
    if not reset_record:
        conn.close()
        return jsonify({"error": "Invalid or expired reset link"}), 400
    
    expiry = datetime.fromisoformat(reset_record[1]) if reset_record[1] else None
    if expiry and datetime.now() > expiry:
        conn.close()
        return jsonify({"error": "Reset link has expired"}), 400
    
    user_id = reset_record[0]
    hashed = generate_password_hash(password)
    cursor.execute("UPDATE users SET password = ? WHERE id = ?", (hashed, user_id))
    cursor.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    
    return jsonify({"success": True, "message": "Password reset successful"}), 200

# ==================== PRICE TRACKING ====================

def parse_price(price_str):
    if not price_str:
        return None
    price_str = str(price_str).strip()
    price_str = re.sub(r'[^\d,.-]', '', price_str)
    price_str = re.sub(r'^[^\d]+', '', price_str)
    price_str = re.sub(r'[^\d]+$', '', price_str)
    if not price_str:
        return None

    # Normalize values like 1,23,456.78 / 1,999 / 1.234,56 into parseable float format.
    if ',' in price_str and '.' in price_str:
        if re.match(r'^\d{1,3}(\.\d{3})+,\d{1,2}$', price_str):
            # European thousand+decimal format: 1.234,56
            price_str = price_str.replace('.', '').replace(',', '.')
        elif re.match(r'^\d{1,3}(,\d{3})+(\.\d+)?$', price_str):
            # US/IN thousand format: 1,234.56 or 1,23,456.78
            price_str = price_str.replace(',', '')
        else:
            # Fallback to decimal comma if comma appears later.
            if price_str.rfind(',') > price_str.rfind('.'):
                price_str = price_str.replace('.', '').replace(',', '.')
            else:
                price_str = price_str.replace(',', '')
    else:
        if ',' in price_str:
            parts = price_str.split(',')
            if len(parts[-1]) == 2:
                price_str = '.'.join(parts)
            else:
                price_str = ''.join(parts)
    try:
        return float(price_str)
    except ValueError:
        return None

def get_site_info(url):
    url_lower = url.lower()
    domain_rules = [
        ([
            'amazon.in', 'flipkart.com', 'myntra.com', 'ajio.com', 'meesho.com', 'snapdeal.com',
            'tatacliq.com', 'reliancedigital.in', 'jiomart.com', 'nykaa.com', 'croma.com',
            'vijaysales.com', 'shopsy.in', 'firstcry.com', 'pepperfry.com', '1mg.com',
            'tata1mg.com', 'netmeds.com', 'bigbasket.com'
        ], 'INR', '₹'),
        (['amazon.co.uk'], 'GBP', '£'),
        (['amazon.com', 'ebay.com', 'walmart.com', 'bestbuy.com', 'target.com'], 'USD', '$'),
    ]
    for domains, currency, symbol in domain_rules:
        if any(domain in url_lower for domain in domains):
            return 'generic', currency, symbol
    return 'generic', 'USD', '$'

def scrape_price(soup, site, currency_symbol):
    """Broader price scraper for multiple e-commerce templates."""
    def valid_price(value):
        return value is not None and 1 <= value <= 20000000

    # 1) Structured data (JSON-LD) used by many stores.
    for script in soup.find_all('script', {'type': 'application/ld+json'}):
        content = script.string or script.get_text()
        if not content:
            continue
        try:
            data = json.loads(content)
        except Exception:
            continue
        queue = data if isinstance(data, list) else [data]
        while queue:
            item = queue.pop(0)
            if isinstance(item, dict):
                offers = item.get('offers')
                if isinstance(offers, dict):
                    price = parse_price(offers.get('price'))
                    if valid_price(price):
                        return price
                elif isinstance(offers, list):
                    for offer in offers:
                        if isinstance(offer, dict):
                            price = parse_price(offer.get('price'))
                            if valid_price(price):
                                return price
                for value in item.values():
                    if isinstance(value, (dict, list)):
                        queue.append(value)
            elif isinstance(item, list):
                queue.extend(item)

    # 2) Common meta/itemprop tags.
    meta_selectors = [
        ('meta', {'property': 'product:price:amount'}, 'content'),
        ('meta', {'property': 'og:price:amount'}, 'content'),
        ('meta', {'name': 'twitter:data1'}, 'content'),
        ('meta', {'itemprop': 'price'}, 'content'),
        ('meta', {'name': 'price'}, 'content'),
    ]
    for tag, attrs, attr_name in meta_selectors:
        elem = soup.find(tag, attrs)
        if elem and elem.get(attr_name):
            price = parse_price(elem.get(attr_name))
            if valid_price(price):
                return price

    # 3) Common e-commerce selectors.
    selector_candidates = [
        '#priceblock_ourprice', '#priceblock_dealprice', '.a-price .a-offscreen',
        '._30jeq3', '._16Jk6d', '.Nx9bqj', '.CEmiEU',  # Flipkart variants
        '.pdp-price', '.product-price', '.price', '.sale-price', '.final-price',
        '[data-testid="price"]', '[itemprop="price"]', '[class*="price"]'
    ]
    for selector in selector_candidates:
        for elem in soup.select(selector):
            text = elem.get('content') or elem.get_text(' ', strip=True)
            price = parse_price(text)
            if valid_price(price):
                return price

    # 4) Regex fallback for currency text in page.
    text = soup.get_text(' ', strip=True)
    currency_patterns = [
        r'₹\s*([0-9][0-9,]*\.?[0-9]{0,2})',
        r'Rs\.?\s*([0-9][0-9,]*\.?[0-9]{0,2})',
        r'INR\s*([0-9][0-9,]*\.?[0-9]{0,2})',
        r'\$\s*([0-9][0-9,]*\.?[0-9]{0,2})',
        r'£\s*([0-9][0-9,]*\.?[0-9]{0,2})'
    ]
    for pattern in currency_patterns:
        matches = re.findall(pattern, text)
        for match in matches:
            price = parse_price(match)
            if valid_price(price):
                return price

    return None

def extract_product_name(soup, url):
    """Extract a cleaner product name for tracker cards."""
    candidates = []

    # Site-specific + common title selectors.
    selector_candidates = [
        '#productTitle',                 # Amazon
        'h1.B_NuCI',                     # Flipkart
        'h1.pdp-name',                   # Myntra-like
        'h1[itemprop="name"]',
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        'meta[name="title"]',
        'h1'
    ]
    for selector in selector_candidates:
        for elem in soup.select(selector):
            text = elem.get('content') or elem.get_text(' ', strip=True)
            if text:
                candidates.append(text.strip())

    if soup.title and soup.title.get_text(strip=True):
        candidates.append(soup.title.get_text(' ', strip=True))

    # Remove noisy/generic strings.
    junk_phrases = [
        'add to your order',
        'amazon.in',
        'amazon.com',
        'flipkart.com',
        'shop online',
        'buy online',
        'best prices in india'
    ]

    def clean_name(name):
        name = re.sub(r'\s+', ' ', name or '').strip()
        name = re.sub(
            r'\s*[-|]\s*(Amazon|Amazon\.in|Flipkart|Myntra|Ajio|Meesho|Snapdeal|Tata CLiQ|Reliance Digital|Nykaa|Croma|JioMart|Vijay Sales|Shopsy|FirstCry|Pepperfry|Tata 1mg|BigBasket)\s*$',
            '',
            name,
            flags=re.IGNORECASE
        ).strip()
        # Remove common ecommerce suffix noise.
        name = re.sub(
            r'\s*online\s+at\s+best\s+prices?\s+in\s+india\.?\s*$',
            '',
            name,
            flags=re.IGNORECASE
        ).strip()
        return name

    for raw in candidates:
        name = clean_name(raw)
        lowered = name.lower()
        if len(name) < 6:
            continue
        if any(phrase in lowered for phrase in junk_phrases):
            continue
        return name

    # Fallback to URL slug when page title is noisy.
    try:
        slug = re.sub(r'[-_]+', ' ', url.split('/')[-1]).strip()
        slug = re.sub(r'\?.*$', '', slug).strip()
        if len(slug) >= 6:
            return slug.title()
    except Exception:
        pass

    return "Product"

@app.route('/get-price', methods=['POST'])
def get_price():
    data = request.json
    url = data.get('url')
    
    if not url:
        return jsonify({"error": "URL is required"}), 400
    
    if url.lower().startswith('test://'):
        mock_price = round(random.uniform(10, 500), 2)
        return jsonify({
            "price": mock_price, "currency": "USD", "currency_symbol": "$",
            "productName": "Test Product", "isTestMode": True
        })
    
    if not (url.startswith('http://') or url.startswith('https://')):
        return jsonify({"error": "Invalid URL format"}), 400

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        response = requests.get(url, headers=headers, timeout=8)
        if response.status_code != 200:
            return jsonify({"error": f"Failed to fetch page (Status: {response.status_code})"}), response.status_code
        
        soup = BeautifulSoup(response.content, "html.parser")
        site, currency, currency_symbol = get_site_info(url)
        price = scrape_price(soup, site, currency_symbol)
        
        product_name = extract_product_name(soup, url)
        
        if price is None:
            return jsonify({"error": "Could not find price on this page"}), 404
        
        return jsonify({
            "price": price, "currency": currency, 
            "currency_symbol": currency_symbol, "productName": product_name
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ==================== STATIC FILES ====================

@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)

# ==================== MAIN ====================

if __name__ == "__main__":
    init_db()
    port = int(os.environ.get('PORT', 8081))
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    app.run(host='0.0.0.0', port=port, debug=debug_mode)
else:
    init_db()
