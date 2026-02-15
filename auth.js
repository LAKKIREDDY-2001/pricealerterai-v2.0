(function () {
  const USERS_KEY = "ai_price_alert_users";
  const SESSION_KEY = "ai_price_alert_session";

  const getUsers = () => {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
    } catch {
      return [];
    }
  };

  const setUsers = (users) => localStorage.setItem(USERS_KEY, JSON.stringify(users));

  const setError = (msg) => {
    const el = document.getElementById("error-message");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
  };

  const tiltRoot = document.querySelector(".tilt-root");
  if (tiltRoot) {
    const maxTilt = Number(tiltRoot.dataset.tilt || 7);
    tiltRoot.addEventListener("mousemove", (e) => {
      const rect = tiltRoot.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      const rotateY = x * maxTilt * 2;
      const rotateX = -y * maxTilt * 2;
      tiltRoot.style.transform = `perspective(1400px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    });
    tiltRoot.addEventListener("mouseleave", () => {
      tiltRoot.style.transform = "perspective(1400px) rotateX(0deg) rotateY(0deg)";
    });
  }

  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const isStrongPassword = (password) => password.length >= 8 && /\d/.test(password) && /[A-Za-z]/.test(password);
  const isValidPhone = (phone) => !phone || /^[+]?[0-9\s-]{8,15}$/.test(phone);

  const signupForm = document.getElementById("signup-form");
  if (signupForm) {
    const state = {
      emailOtp: null,
      phoneOtp: null,
      emailVerified: false,
      phoneVerified: false,
      needsPhone: false,
      signupDraft: null
    };

    const verificationSection = document.getElementById("verification-section");
    const emailTarget = document.querySelector("#email-address .target");
    const phoneTarget = document.querySelector("#phone-number .target");
    const phoneBlock = document.getElementById("phone-verification");
    const completeBtn = document.getElementById("complete-signup");

    const emailStatus = document.getElementById("email-status");
    const phoneStatus = document.getElementById("phone-status");

    const step2 = document.getElementById("step-2");
    const step3 = document.getElementById("step-3");

    const updateCompleteState = () => {
      const done = state.emailVerified && (!state.needsPhone || state.phoneVerified);
      if (completeBtn) completeBtn.disabled = !done;
      if (done && step3) step3.classList.add("active");
    };

    const setStatus = (node, ok) => {
      if (!node) return;
      node.textContent = ok ? "Verified" : "Pending";
      node.classList.toggle("success", !!ok);
    };

    signupForm.addEventListener("submit", (e) => {
      e.preventDefault();
      setError("");

      const username = document.getElementById("username")?.value.trim();
      const email = document.getElementById("email")?.value.trim().toLowerCase();
      const phone = document.getElementById("phone")?.value.trim();
      const password = document.getElementById("password")?.value || "";
      const confirm = document.getElementById("confirm_password")?.value || "";
      const terms = document.getElementById("terms")?.checked;

      if (!username || username.length < 3) return setError("Username must be at least 3 characters.");
      if (!isValidEmail(email)) return setError("Enter a valid email address.");
      if (!isValidPhone(phone)) return setError("Enter a valid phone number.");
      if (!isStrongPassword(password)) return setError("Password must be 8+ chars with letters and numbers.");
      if (password !== confirm) return setError("Passwords do not match.");
      if (!terms) return setError("Please accept Terms & Conditions.");

      const existing = getUsers().find((u) => u.email === email);
      if (existing) return setError("An account with this email already exists. Please sign in.");

      state.signupDraft = {
        username,
        email,
        phone,
        password,
        createdAt: new Date().toISOString()
      };
      state.needsPhone = !!phone;
      state.emailVerified = false;
      state.phoneVerified = false;
      state.emailOtp = null;
      state.phoneOtp = null;

      if (emailTarget) emailTarget.textContent = email;
      if (phoneTarget) phoneTarget.textContent = phone || "Not provided";
      if (phoneBlock) phoneBlock.style.display = phone ? "block" : "none";

      signupForm.style.display = "none";
      if (verificationSection) verificationSection.style.display = "block";
      if (step2) step2.classList.add("active");
      setStatus(emailStatus, false);
      setStatus(phoneStatus, false);
      updateCompleteState();
    });

    const makeOtp = () => String(Math.floor(100000 + Math.random() * 900000));

    const sendEmailBtn = document.getElementById("send-email-otp");
    sendEmailBtn?.addEventListener("click", () => {
      if (!state.signupDraft) return;
      state.emailOtp = makeOtp();
      sendEmailBtn.disabled = true;
      sendEmailBtn.textContent = `Sent (${state.emailOtp})`;
      setTimeout(() => {
        sendEmailBtn.disabled = false;
        sendEmailBtn.innerHTML = '<i class="fa fa-paper-plane"></i> Resend OTP';
      }, 5000);
    });

    const sendPhoneBtn = document.getElementById("send-phone-otp");
    sendPhoneBtn?.addEventListener("click", () => {
      if (!state.signupDraft || !state.needsPhone) return;
      state.phoneOtp = makeOtp();
      sendPhoneBtn.disabled = true;
      sendPhoneBtn.textContent = `Sent (${state.phoneOtp})`;
      setTimeout(() => {
        sendPhoneBtn.disabled = false;
        sendPhoneBtn.innerHTML = '<i class="fa fa-paper-plane"></i> Resend OTP';
      }, 5000);
    });

    document.getElementById("verify-email-otp")?.addEventListener("click", () => {
      const code = document.getElementById("email-otp")?.value.trim();
      if (!state.emailOtp) return setError("Send email OTP first.");
      if (code !== state.emailOtp) return setError("Invalid email OTP.");
      state.emailVerified = true;
      setError("");
      setStatus(emailStatus, true);
      updateCompleteState();
    });

    document.getElementById("verify-phone-otp")?.addEventListener("click", () => {
      const code = document.getElementById("phone-otp")?.value.trim();
      if (!state.phoneOtp) return setError("Send phone OTP first.");
      if (code !== state.phoneOtp) return setError("Invalid phone OTP.");
      state.phoneVerified = true;
      setError("");
      setStatus(phoneStatus, true);
      updateCompleteState();
    });

    completeBtn?.addEventListener("click", () => {
      if (!state.signupDraft) return;
      if (!(state.emailVerified && (!state.needsPhone || state.phoneVerified))) {
        return setError("Complete all required verification steps.");
      }

      const users = getUsers();
      users.push(state.signupDraft);
      setUsers(users);
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        email: state.signupDraft.email,
        username: state.signupDraft.username,
        loggedInAt: new Date().toISOString()
      }));

      completeBtn.disabled = true;
      completeBtn.innerHTML = '<span>Success! Redirecting...</span> <i class="fa fa-check"></i>';
      setTimeout(() => {
        window.location.href = "dashboard.html";
      }, 900);
    });
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      setError("");

      const email = document.getElementById("login-email")?.value.trim().toLowerCase();
      const password = document.getElementById("login-password")?.value || "";
      const remember = !!document.getElementById("remember")?.checked;

      if (!isValidEmail(email)) return setError("Enter a valid email.");
      if (!password) return setError("Password is required.");

      const user = getUsers().find((u) => u.email === email && u.password === password);
      if (!user) return setError("Invalid email or password. Sign up first if new.");

      localStorage.setItem(SESSION_KEY, JSON.stringify({
        email: user.email,
        username: user.username,
        remember,
        loggedInAt: new Date().toISOString()
      }));

      const loginBtn = document.getElementById("login-btn");
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span>Signing in...</span> <i class="fa fa-spinner fa-spin"></i>';
      }

      setTimeout(() => {
        window.location.href = "dashboard.html";
      }, 700);
    });

    document.getElementById("forgot-password-link")?.addEventListener("click", (e) => {
      e.preventDefault();
      setError("Password reset can be connected to backend API later.");
    });
  }
})();
