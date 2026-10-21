(() => {
  "use strict";

  const profileColumns = "id,role,display_name,telepon,alamat";

  function getClient() {
    if (!window.RetailConfig?.getClient) {
      const error = new Error("Konfigurasi Supabase tidak dapat dimuat.");
      error.code = "SUPABASE_CONFIG_MISSING";
      throw error;
    }
    return window.RetailConfig.getClient();
  }

  function profileError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function mapAuthError(error, action = "autentikasi") {
    const message = String(error?.message || "").toLowerCase();
    const status = Number(error?.status || error?.statusCode || 0);
    if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
      if (action === "recovery") {
        return new Error("Supabase sedang membatasi pengiriman email pemulihan (HTTP 429). Jangan kirim permintaan berulang. Tunggu sampai batas Supabase berakhir, lalu minta tautan sekali lagi. Jika tetap terjadi, administrator proyek perlu memeriksa Authentication → Rate Limits dan konfigurasi email/SMTP.");
      }
      if (action === "registration") {
        return new Error("Supabase sedang membatasi pendaftaran atau pengiriman email (HTTP 429). Jangan daftar berulang kali. Tunggu sampai batas Supabase berakhir; administrator proyek perlu memeriksa Authentication → Rate Limits dan konfigurasi email/SMTP.");
      }
      return new Error("Supabase sementara membatasi percobaan autentikasi (HTTP 429). Tunggu sebelum mencoba lagi dan jangan kirim permintaan berulang.");
    }
    if (message.includes("invalid login credentials")) {
      return new Error("Email atau password tidak valid. Periksa kembali atau gunakan fitur reset password Supabase.");
    }
    if (message.includes("email not confirmed")) {
      return new Error("Email belum dikonfirmasi. Buka tautan konfirmasi yang dikirim Supabase, lalu coba masuk kembali.");
    }
    if (message.includes("already registered") || message.includes("user already registered")) {
      return new Error("Email sudah terdaftar. Silakan masuk atau gunakan prosedur reset password.");
    }
    if (message.includes("password should be") || message.includes("weak_password")) {
      return new Error("Password belum memenuhi kebijakan keamanan Supabase.");
    }
    return new Error("Permintaan autentikasi ke Supabase gagal. Periksa konfigurasi proyek dan coba lagi.");
  }

  async function fetchProfile(client, authUser) {
    const { data: profile, error } = await client
      .from("profiles")
      .select(profileColumns)
      .eq("id", authUser.id)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") {
        throw profileError(
          "PROFILE_SCHEMA_MISSING",
          "Tabel public.profiles belum tersedia pada proyek Supabase ini. Administrator perlu menjalankan migrasi database sebelum akun dapat masuk."
        );
      }
      throw profileError(
        "PROFILE_READ_FAILED",
        "Login terautentikasi, tetapi profil tidak dapat dibaca. Periksa public.profiles, izin SELECT, dan kebijakan RLS."
      );
    }
    if (!profile) {
      throw profileError(
        "PROFILE_NOT_FOUND",
        "Profil pengguna belum ditemukan. Minta administrator menjalankan migrasi profil dan memeriksa trigger pendaftaran."
      );
    }
    if (!["owner", "customer"].includes(profile.role)) {
      throw profileError(
        "ROLE_INVALID",
        "Role pengguna belum dikonfigurasi dengan benar. Minta administrator mengatur public.profiles.role menjadi owner atau customer."
      );
    }

    return {
      id: authUser.id,
      email: authUser.email || "",
      role: profile.role,
      displayName: profile.display_name || authUser.user_metadata?.full_name || "",
      phone: profile.telepon || "",
      address: profile.alamat || ""
    };
  }

  async function userFromSession(client) {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      throw profileError(
        "AUTH_SESSION_INVALID",
        "Sesi Supabase tidak dapat diverifikasi. Silakan masuk kembali."
      );
    }
    return fetchProfile(client, data.user);
  }

  async function signIn(email, password) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("Masukkan alamat email yang valid.");
    }
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("Password wajib diisi.");
    }

    const client = getClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: normalizedEmail,
      password
    });
    if (error) throw mapAuthError(error);
    if (!data.session || !data.user) {
      throw new Error("Supabase tidak mengembalikan sesi login. Periksa status konfirmasi email pada proyek.");
    }

    try {
      return await userFromSession(client);
    } catch (profileFailure) {
      const { error: signOutError } = await client.auth.signOut();
      if (signOutError) {
        throw new Error(`${profileFailure.message} Sesi gagal diakhiri otomatis; pilih Keluar lalu hubungi administrator.`);
      }
      throw profileFailure;
    }
  }

  async function getCurrentUser() {
    const client = getClient();
    const { data, error } = await client.auth.getSession();
    if (error) {
      throw profileError("AUTH_SESSION_INVALID", "Sesi Supabase tidak dapat dibaca. Silakan masuk kembali.");
    }
    if (!data.session) return null;
    return userFromSession(client);
  }

  async function registerCustomer(name, email, password) {
    const displayName = String(name || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!displayName) throw new Error("Nama wajib diisi.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("Masukkan alamat email yang valid.");
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("Password harus berisi minimal 8 karakter.");
    }

    const client = getClient();
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail,
      password,
      options: { data: { full_name: displayName } }
    });
    if (error) throw mapAuthError(error, "registration");
    if (!data.user) throw new Error("Supabase tidak membuat akun. Periksa pengaturan pendaftaran proyek.");
    if (!data.session) {
      return {
        needsEmailConfirmation: true,
        accountMayAlreadyExist: !data.user.identities?.length
      };
    }
    return { user: await userFromSession(client), needsEmailConfirmation: false };
  }

  async function sendPasswordReset(email, redirectTo) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("Masukkan alamat email yang valid.");
    }

    const options = redirectTo ? { redirectTo } : undefined;
    const { error } = await getClient().auth.resetPasswordForEmail(normalizedEmail, options);
    if (error) throw mapAuthError(error, "recovery");
  }

  async function updateProfile(values) {
    const client = getClient();
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.role !== "customer") {
      throw new Error("Sesi pelanggan tidak ditemukan.");
    }

    const { data, error } = await client
      .from("profiles")
      .update({
        display_name: String(values.displayName || "").trim(),
        telepon: String(values.phone || "").trim(),
        alamat: String(values.address || "").trim()
      })
      .eq("id", currentUser.id)
      .select(profileColumns)
      .single();
    if (error || !data) {
      throw new Error("Profil tidak dapat disimpan. Periksa izin update kolom profil dan kebijakan RLS.");
    }
    return {
      ...currentUser,
      displayName: data.display_name || "",
      phone: data.telepon || "",
      address: data.alamat || ""
    };
  }

  async function updatePassword(password) {
    if (typeof password !== "string" || password.length < 8) {
      throw new Error("Kata sandi harus berisi minimal 8 karakter.");
    }
    const { data, error } = await getClient().auth.updateUser({ password });
    if (error) throw mapAuthError(error);
    if (!data.user) throw new Error("Supabase tidak mengonfirmasi perubahan kata sandi.");
    return getCurrentUser();
  }

  async function signOut() {
    const { error } = await getClient().auth.signOut();
    if (error) throw new Error("Logout Supabase gagal. Periksa koneksi lalu coba lagi.");
  }

  window.RetailAuth = {
    getCurrentUser,
    signIn,
    registerCustomer,
    sendPasswordReset,
    updateProfile,
    updatePassword,
    signOut,
    onAuthStateChange(callback) {
      const { data } = getClient().auth.onAuthStateChange(callback);
      return data.subscription;
    }
  };
})();
