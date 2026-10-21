(() => {
  "use strict";

  const projectUrl = "https://zbpwbcxsktixzopyazyr.supabase.co";
  const publishableKey = "sb_publishable_nNvPMVHzcq9kP1tdDSCBlQ_PLQn_EDc";
  let client = null;
  let guestClient = null;

  function isSecretKey(key) {
    if (/service_role|sb_secret_/i.test(key)) return true;
    const segments = key.split(".");
    if (segments.length !== 3) return false;
    try {
      const payload = JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.role === "service_role";
    } catch {
      return false;
    }
  }

  function createClient(persistSession) {
    if (!projectUrl || !publishableKey) {
      const error = new Error("Konfigurasi Supabase belum benar. Isi Project URL dan publishable/anon key di frontend/js/config.js.");
      error.code = "SUPABASE_CONFIG_MISSING";
      throw error;
    }
    if (!window.supabase?.createClient) {
      const error = new Error("Supabase JavaScript SDK tidak termuat. Periksa koneksi internet dan muat ulang halaman.");
      error.code = "SUPABASE_SDK_MISSING";
      throw error;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(projectUrl);
    } catch {
      const error = new Error("Project URL Supabase tidak valid.");
      error.code = "SUPABASE_CONFIG_INVALID";
      throw error;
    }
    if (parsedUrl.protocol !== "https:" || isSecretKey(publishableKey)) {
      const error = new Error("Gunakan URL HTTPS dan publishable/anon key. Secret/service-role key tidak boleh dipakai di frontend.");
      error.code = "SUPABASE_CONFIG_INVALID";
      throw error;
    }
    return window.supabase.createClient(projectUrl, publishableKey, {
      auth: {
        persistSession,
        autoRefreshToken: persistSession,
        detectSessionInUrl: persistSession
      }
    });
  }

  function getClient() {
    if (!client) client = createClient(true);
    return client;
  }

  function getGuestClient() {
    if (!guestClient) guestClient = createClient(false);
    return guestClient;
  }

  window.RetailConfig = { getClient, getGuestClient };
})();
