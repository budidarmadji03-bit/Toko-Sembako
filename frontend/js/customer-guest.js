(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const money = value => new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const trackingStorageKey = "tokoBudiGuestTrackingToken";
  const pendingStorageKey = "tokoBudiGuestCheckoutPending";
  const db = () => window.RetailConfig.getGuestClient();
  let products = [];
  let cart = [];
  let toastTimer;

  async function checked(result) {
    const { data, error } = await result;
    if (error) throw new Error(error.message || "Permintaan ke Supabase gagal.");
    return data;
  }

  function message(text, isError = false) {
    const element = $("#guestMessage");
    element.textContent = text;
    element.classList.toggle("hidden", !text);
    element.classList.toggle("error", isError);
  }

  function setupError(text) {
    const element = $("#guestSetupError");
    element.classList.toggle("hidden", !text);
    element.innerHTML = text
      ? `<i class="fa-solid fa-triangle-exclamation"></i><span>${esc(text)} Jalankan migrasi <code>backend/sql/08_guest_checkout.sql</code> di Supabase SQL Editor, lalu tekan <b>Muat ulang</b>. Jangan buat transaksi manual atau memakai data DEMO sebagai pengganti.</span>`
      : "";
  }

  function toast(text, isError = false) {
    const element = $("#guestToast");
    element.textContent = text;
    element.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = "toast"; }, 3500);
  }

  function productImage(product) {
    if (product.foto_url) return `<img src="${esc(product.foto_url)}" alt="${esc(product.nama)}" loading="lazy">`;
    const name = String(product.nama || "").toLowerCase();
    const file = /air mineral|air minum|mineral/.test(name) ? "lemineral.jpg"
      : /\bmi\b|\bmie\b|noodle/.test(name) ? "mie-sedap.jpg"
      : /susu|milk/.test(name) ? "susu-uht.png"
      : /beras|rice/.test(name) ? "rice.jpg"
      : /minyak|oil/.test(name) ? "cooking-oil.jpg"
      : /gula|sugar/.test(name) ? "sugar.jpg"
      : /tepung|flour/.test(name) ? "flour.jpg" : "";
    return file ? `<img src="../assets/products/${file}" alt="${esc(product.nama)}" loading="lazy" onerror="this.hidden=true">`
      : '<span class="customer-no-image"><i class="fa-solid fa-box"></i></span>';
  }

  function stock(product) {
    return Math.max(0, Number(product.stok) || 0);
  }

  function renderCatalog() {
    const query = $("#guestSearch").value.trim().toLowerCase();
    const category = $("#guestCategory").value;
    const rows = products.filter(product => product.aktif !== false && (!category || product.kategori === category)
      && [product.nama, product.kategori, product.sku].some(value => String(value || "").toLowerCase().includes(query)));
    $("#guestCatalog").innerHTML = rows.length ? rows.map(product => `
      <article class="customer-product"><div class="customer-product-image">${productImage(product)}</div>
        <div class="customer-product-info"><small>${esc(product.kategori)}</small><h3>${esc(product.nama)}</h3>
          <span class="customer-availability">${stock(product) > 0 ? `Tersedia · ${stock(product)} ${esc(product.satuan)}` : "Stok habis"}</span>
          <b>${money(product.harga_jual)} <small>/ ${esc(product.satuan)}</small></b>
          <button class="btn-primary" type="button" data-guest-add="${esc(product.id)}" ${stock(product) <= 0 ? "disabled" : ""}>Tambah ke keranjang</button>
        </div></article>`).join("")
      : '<div class="empty"><i class="fa-solid fa-box-open"></i><b>Produk tidak ditemukan</b><p>Ubah pencarian atau filter kategori.</p></div>';
  }

  function renderCart() {
    $("#guestCartCount").textContent = `${cart.reduce((sum, item) => sum + item.qty, 0)} produk`;
    $("#guestTotal").textContent = money(cart.reduce((sum, item) => sum + item.qty * item.price, 0));
    $("#guestCheckout").disabled = !cart.length;
    $("#guestCartItems").innerHTML = cart.length ? cart.map(item => `
      <div class="customer-cart-item"><div><b>${esc(item.name)}</b><small>${money(item.price)} / ${esc(item.unit)}</small></div>
        <div class="qty-control"><button type="button" data-guest-qty="${esc(item.id)}" data-delta="-1" aria-label="Kurangi">−</button><span>${item.qty}</span><button type="button" data-guest-qty="${esc(item.id)}" data-delta="1" aria-label="Tambah">+</button></div>
        <button type="button" class="remove-item" data-guest-remove="${esc(item.id)}" aria-label="Hapus"><i class="fa-solid fa-xmark"></i></button></div>`).join("")
      : '<div class="empty"><i class="fa-solid fa-basket-shopping"></i><b>Keranjang kosong</b><p>Pilih produk dari katalog.</p></div>';
  }

  function addToCart(id) {
    const product = products.find(row => String(row.id) === String(id));
    if (!product || stock(product) <= 0) return;
    const item = cart.find(row => String(row.id) === String(id));
    if (item && item.qty >= stock(product)) {
      toast("Jumlah melebihi stok tersedia.", true);
      return;
    }
    if (item) item.qty++;
    else cart.push({ id: product.id, name: product.nama, unit: product.satuan, price: Number(product.harga_jual), qty: 1 });
    renderCart();
  }

  function uuid() {
    if (!window.crypto?.randomUUID) throw new Error("Browser ini tidak mendukung kode pesanan aman. Gunakan Chrome atau Edge terbaru.");
    return window.crypto.randomUUID();
  }

  function checkoutPayload() {
    return {
      recipientName: $("#guestName").value.trim(),
      recipientPhone: $("#guestPhone").value.trim(),
      deliveryAddress: $("#guestAddress").value.trim(),
      deliveryNote: $("#guestNote").value.trim(),
      paymentMethod: $("#guestPayment").value,
      items: cart.map(item => ({ product_id: item.id, qty: item.qty }))
    };
  }

  function samePayload(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  async function checkout() {
    const button = $("#guestCheckout");
    button.disabled = true;
    message("");
    try {
      const requested = checkoutPayload();
      if (!requested.recipientName || !requested.recipientPhone || !requested.deliveryAddress) {
        throw new Error("Nama penerima, nomor telepon, dan alamat wajib diisi.");
      }
      let pending;
      try {
        pending = JSON.parse(localStorage.getItem(pendingStorageKey) || "null");
      } catch {
        throw new Error("Data checkout tersimpan rusak. Jangan hapus sebelum memastikan pesanan terakhir di Owner.");
      }
      if (pending && !samePayload(pending.payload, requested)) {
        throw new Error("Ada checkout yang belum terkonfirmasi dari percobaan sebelumnya. Kirim ulang data yang sama untuk memastikan hasilnya, atau lacak pesanan jika kode sudah diterima.");
      }
      if (!pending) {
        pending = { requestId: uuid(), trackingToken: uuid(), payload: requested };
        try {
          localStorage.setItem(pendingStorageKey, JSON.stringify(pending));
        } catch (error) {
          throw new Error(`Browser tidak dapat menyimpan kunci checkout agar permintaan aman diulang: ${error.message}`);
        }
      }
      const result = await checked(db().rpc("guest_checkout", {
        p_items: pending.payload.items,
        p_payment_method: pending.payload.paymentMethod,
        p_request_id: pending.requestId,
        p_tracking_token: pending.trackingToken,
        p_recipient_name: pending.payload.recipientName,
        p_recipient_phone: pending.payload.recipientPhone,
        p_delivery_address: pending.payload.deliveryAddress,
        p_delivery_note: pending.payload.deliveryNote || null
      }));
      localStorage.setItem(trackingStorageKey, pending.trackingToken);
      localStorage.removeItem(pendingStorageKey);
      $("#trackingToken").value = pending.trackingToken;
      cart = [];
      renderCart();
      message(`Pesanan ${result.nomor_nota} tercatat di sistem toko dan menunggu konfirmasi Owner. Simpan kode pelacakan berikut: ${pending.trackingToken}`);
      try {
        products = await checked(db().from("customer_catalog").select("*").order("nama"));
        renderCatalog();
      } catch (error) {
        toast(`Pesanan berhasil dibuat, tetapi stok katalog belum dapat diperbarui: ${error.message}`, true);
      }
      await trackOrder();
    } catch (error) {
      message(error.message || "Checkout gagal. Periksa koneksi dan migrasi Supabase.", true);
    } finally {
      button.disabled = !cart.length;
    }
  }

  async function trackOrder() {
    const token = $("#trackingToken").value.trim();
    const target = $("#trackingResult");
    target.textContent = "";
    if (!token) {
      target.textContent = "Masukkan kode pelacakan.";
      return;
    }
    try {
      const order = await checked(db().rpc("guest_order_status", { p_tracking_token: token }));
      const items = Array.isArray(order.items) ? order.items : [];
      const status = ({
        menunggu: "Menunggu konfirmasi Owner",
        diproses: "Sedang diproses",
        dalam_pengiriman: "Dalam pengiriman",
        selesai: "Sudah sampai",
        gagal_dikirim: "Gagal dikirim",
        dibatalkan: "Ditolak / dibatalkan"
      })[order.status] || order.status;
      target.innerHTML = `<div class="customer-message"><b>${esc(order.nomor_nota)}</b><br>${esc(order.recipient_name)} · ${new Date(order.tanggal).toLocaleString("id-ID")}<br>Status: <b>${esc(status)}</b><br>Status pembayaran: ${esc(order.status_pembayaran)}<br>Total: <b>${money(order.total)}</b><ul>${items.map(item => `<li>${esc(item.name)} × ${Number(item.quantity)} — ${money(item.subtotal)}</li>`).join("")}</ul></div>`;
    } catch (error) {
      target.textContent = error.message || "Status pesanan tidak dapat dimuat.";
    }
  }

  async function loadCatalog() {
    $("#guestCatalog").innerHTML = '<div class="empty"><i class="fa-solid fa-cloud-arrow-down"></i><b>Memuat katalog toko...</b></div>';
    $("#guestCheckout").disabled = true;
    setupError("");
    try {
      const rows = await checked(db().from("customer_catalog").select("*").order("nama"));
      products = rows.filter(product => product.aktif !== false);
      const categories = [...new Set(products.map(product => product.kategori).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
      $("#guestCategory").innerHTML = '<option value="">Semua kategori</option>' + categories.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
      renderCatalog();
      renderCart();
      if (!products.length) {
        setupError("Katalog terbaca, tetapi belum ada produk aktif di database toko.");
      }
      return true;
    } catch (error) {
      products = [];
      renderCart();
      $("#guestCatalog").innerHTML = `<div class="empty"><i class="fa-solid fa-triangle-exclamation"></i><b>Katalog Supabase belum dapat dimuat</b><p>${esc(error.message)}</p></div>`;
      setupError("Belanja tamu memerlukan izin baca anonim pada katalog dan RPC checkout dari migrasi 08. Migrasi tersebut belum terdeteksi pada proyek Supabase ini.");
      message(`Katalog gagal dimuat dari Supabase: ${error.message}`, true);
      return false;
    }
  }

  async function init() {
    try {
      const loaded = await loadCatalog();
      const savedToken = localStorage.getItem(trackingStorageKey);
      if (savedToken) {
        $("#trackingToken").value = savedToken;
        await trackOrder();
      }
      if (!loaded) return;
    } catch (error) {
      message(`Halaman belanja gagal diinisialisasi: ${error.message}`, true);
    }
  }

  $("#guestSearch").addEventListener("input", renderCatalog);
  $("#guestCategory").addEventListener("change", renderCatalog);
  $("#guestCatalog").addEventListener("click", event => {
    const button = event.target.closest("[data-guest-add]");
    if (button) addToCart(button.dataset.guestAdd);
  });
  $("#guestCartItems").addEventListener("click", event => {
    const quantity = event.target.closest("[data-guest-qty]");
    const remove = event.target.closest("[data-guest-remove]");
    if (quantity) {
      const item = cart.find(row => String(row.id) === quantity.dataset.guestQty);
      const product = products.find(row => String(row.id) === quantity.dataset.guestQty);
      if (item && product) {
        item.qty = Math.max(0, Math.min(stock(product), item.qty + Number(quantity.dataset.delta)));
        if (!item.qty) cart = cart.filter(row => row !== item);
        renderCart();
      }
    }
    if (remove) {
      cart = cart.filter(row => String(row.id) !== remove.dataset.guestRemove);
      renderCart();
    }
  });
  $("#clearGuestCart").addEventListener("click", () => { cart = []; renderCart(); });
  $("#guestCheckout").addEventListener("click", checkout);
  $("#trackOrder").addEventListener("click", trackOrder);
  $("#refreshGuestCatalog").addEventListener("click", async () => {
    const button = $("#refreshGuestCatalog");
    button.disabled = true;
    try {
      const loaded = await loadCatalog();
      if (loaded) message("Katalog berhasil diperbarui dari Supabase.");
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("DOMContentLoaded", init);
})();
