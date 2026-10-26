(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const auth = window.RetailAuth;
  const forms = ["#loginForm", "#registerForm", "#recoveryForm", "#setPasswordForm"];
  const noticeMessages = {
    PROFILE_NOT_FOUND: "Profil pengguna belum ditemukan. Minta administrator menjalankan migrasi Supabase Auth dan memeriksa trigger pendaftaran.",
    PROFILE_SCHEMA_MISSING: "Tabel public.profiles belum tersedia. Administrator harus menjalankan migrasi backend/sql sebelum login.",
    ROLE_INVALID: "Role pengguna belum dikonfigurasi. Minta administrator menetapkan role owner atau customer di public.profiles.",
    PROFILE_READ_FAILED: "Profil gagal dibaca. Periksa koneksi, tabel public.profiles, dan kebijakan RLS.",
    AUTH_SESSION_INVALID: "Sesi tidak dapat diverifikasi. Silakan masuk kembali.",
    AUTH_CONNECTION_TIMEOUT: "Pemeriksaan sesi Supabase terlalu lama. Data Anda tidak dihapus. Silakan masuk kembali; jika gagal, periksa koneksi internet lalu coba lagi."
  };

  function showForm(form) {
    forms.forEach(selector => $(selector).classList.toggle("hidden", selector !== form));
  }

  function selectInitialForm() {
    if (new URLSearchParams(location.search).get("mode") === "register") {
      showForm("#registerForm");
    }
  }

  function showMessage(element, message, isError = true) {
    element.textContent = message;
    element.classList.toggle("error", isError);
  }

  function setBusy(button, busy, busyText) {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    if (button.id === "loginButton") {
      $("#loginButtonText").textContent = busy ? busyText : "Masuk";
    }
  }

  function withTimeout(promise,milliseconds,message){
    let timeout;
    return Promise.race([
      promise,
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(message)),milliseconds)})
    ]).finally(()=>clearTimeout(timeout));
  }

  async function redirectForRole(user, messageElement) {
    const target = user.role === "owner" ? "index.html" : "customer.html";
    if (location.protocol !== "file:") {
      try {
        const response = await fetch(new URL(target, location.href), {
          method: "HEAD",
          cache: "no-store",
          credentials: "same-origin"
        });
        if (!response.ok) throw new Error();
      } catch {
        await auth.signOut();
        showMessage(messageElement, "Login berhasil, tetapi halaman tujuan tidak ditemukan. Periksa lokasi file dan konfigurasi deployment.");
        return;
      }
    }
    location.replace(target);
  }

  function showRedirectNotice() {
    const notice = new URLSearchParams(location.search).get("notice");
    if (notice && noticeMessages[notice]) {
      showMessage($("#loginMessage"), noticeMessages[notice]);
      history.replaceState(null, "", location.pathname);
    }
  }

  async function init() {
    showRedirectNotice();
    selectInitialForm();
    try {
      const flow = new URLSearchParams(location.search).get("flow");
      const tokenType = new URLSearchParams(location.hash.slice(1)).get("type");
      if (flow === "invite" || tokenType === "invite") {
        const invitedUser = await auth.getCurrentUser();
        if (!invitedUser) {
          showMessage(
            $("#loginMessage"),
            "Undangan belum aktif atau tautannya kedaluwarsa. Minta administrator mengirim ulang undangan Supabase."
          );
          return;
        }
        showForm("#setPasswordForm");
        return;
      }
      if (flow === "recovery" || tokenType === "recovery") {
        const recoveryUser = await auth.getCurrentUser();
        if (!recoveryUser) {
          showMessage(
            $("#loginMessage"),
            "Sesi pemulihan tidak ditemukan atau tautan kedaluwarsa. Minta tautan reset baru dari halaman ini."
          );
          return;
        }
        $("#setPasswordTitle").textContent = "Buat Password Baru";
        $("#setPasswordDescription").textContent = "Tautan pemulihan terverifikasi. Tetapkan password baru untuk akun Anda.";
        showForm("#setPasswordForm");
        return;
      }
      const currentUser = await withTimeout(
        auth.getCurrentUser(),
        12000,
        noticeMessages.AUTH_CONNECTION_TIMEOUT
      );
      if (currentUser) await redirectForRole(currentUser, $("#loginMessage"));
    } catch (error) {
      showMessage($("#loginMessage"), error.message || "Status login tidak dapat diperiksa.");
    }
  }

  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const button = form.querySelector('[type="submit"]');
    const message = $("#loginMessage");
    showMessage(message, "", false);
    setBusy(button, true, "Memeriksa...");
    try {
      const user = await auth.signIn($("#email").value, $("#password").value);
      await redirectForRole(user, message);
    } catch (error) {
      showMessage(message, error.message || "Login gagal. Periksa koneksi dan konfigurasi Supabase.");
    } finally {
      $("#password").value = "";
      setBusy(button, false, "");
    }
  });

  $("#registerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const button = form.querySelector('[type="submit"]');
    const message = $("#registerMessage");
    showMessage(message, "", false);
    setBusy(button, true, "");
    try {
      const result = await auth.registerCustomer(
        $("#registerName").value,
        $("#registerEmail").value,
        $("#registerPassword").value
      );
      $("#registerPassword").value = "";
      if (result.needsEmailConfirmation) {
        const notice = result.accountMayAlreadyExist
          ? "Supabase tidak menerbitkan sesi pendaftaran. Alamat mungkin sudah terdaftar atau perlu konfirmasi email. Coba masuk atau gunakan “Lupa password?”; periksa juga inbox dan folder spam."
          : "Pendaftaran diterima. Konfirmasikan email melalui tautan dari Supabase sebelum masuk.";
        showMessage(message, notice, false);
        return;
      }
      showMessage(message, "Akun pelanggan berhasil dibuat.", false);
      await redirectForRole(result.user, message);
    } catch (error) {
      showMessage(message, error.message || "Pendaftaran gagal. Periksa konfigurasi Supabase.");
    } finally {
      setBusy(button, false, "");
    }
  });

  $("#showRecovery").addEventListener("click", () => {
    $("#recoveryEmail").value = $("#email").value.trim();
    showForm("#recoveryForm");
  });
  $("#backFromRecovery").addEventListener("click", () => showForm("#loginForm"));
  $("#recoveryForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const button = $("#recoveryButton");
    const message = $("#recoveryMessage");
    showMessage(message, "", false);
    setBusy(button, true, "");
    try {
      const redirectTo = location.protocol === "file:"
        ? undefined
        : new URL("login.html?flow=recovery", location.href).href;
      await auth.sendPasswordReset($("#recoveryEmail").value, redirectTo);
      showMessage(
        message,
        "Jika akun dengan email tersebut tersedia, tautan reset telah diminta. Periksa inbox dan folder spam.",
        false
      );
    } catch (error) {
      showMessage(message, error.message || "Permintaan reset gagal. Periksa koneksi dan konfigurasi Supabase.");
    } finally {
      setBusy(button, false, "");
    }
  });

  $("#setPasswordForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const message = $("#setPasswordMessage");
    const button = $("#setPasswordButton");
    const password = $("#newPassword").value;
    if (password !== $("#confirmPassword").value) {
      showMessage(message, "Kedua kata sandi tidak sama.");
      return;
    }

    showMessage(message, "", false);
    setBusy(button, true, "");
    try {
      const user = await auth.updatePassword(password);
      $("#newPassword").value = "";
      $("#confirmPassword").value = "";
      await redirectForRole(user, message);
    } catch (error) {
      showMessage(message, error.message || "Kata sandi tidak dapat disimpan. Buka kembali tautan undangan Supabase.");
    } finally {
      setBusy(button, false, "");
    }
  });

  $("#togglePassword").addEventListener("click", () => {
    const input = $("#password");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    $("#togglePassword").textContent = visible ? "Sembunyikan" : "Tampilkan";
  });
  $("#showRegister").addEventListener("click", () => showForm("#registerForm"));
  $("#showLogin").addEventListener("click", () => showForm("#loginForm"));

  init();
})();
