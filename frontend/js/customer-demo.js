(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const money = value => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const storageKey = "tokoBudiCustomerDemo";
  const localProductsKey = "tokoBudiDemoLocalProducts";
  let products = [];
  let cart = [];
  let state = { stock: {}, orders: [] };
  let toastTimer;

  function readStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
      if (!value || typeof value !== "object") throw new Error("format data tidak valid");
      return value;
    } catch (error) {
      throw new Error(`Data DEMO lokal tidak dapat dibaca (${error.message}). Data tidak dihapus.`);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (error) {
      throw new Error(`Pesanan DEMO tidak dapat disimpan di browser (${error.message}). Periksa ruang penyimpanan.`);
    }
  }

  function available(product) {
    return Math.max(0, Number(state.stock[product.sku] ?? product.stok) || 0);
  }

  function image(product) {
    if (product.foto) return `<img src="${esc(product.foto)}" alt="${esc(product.nama)}" loading="lazy">`;
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

  function renderCatalog() {
    const query = $("#demoCatalogSearch").value.trim().toLowerCase();
    const category = $("#demoCategoryFilter").value;
    const rows = products.filter(product => (!category || product.kategori === category)
      && [product.nama, product.kategori, product.sku].some(value => String(value || "").toLowerCase().includes(query)));
    $("#demoCatalog").innerHTML = rows.length ? rows.map(product => {
      const stock = available(product);
      return `<article class="customer-product"><div class="customer-product-image">${image(product)}</div>
        <div class="customer-product-info"><small>${esc(product.kategori)}</small><h3>${esc(product.nama)}</h3>
          <span class="customer-availability">${stock > 0 ? `Tersedia · ${stock} ${esc(product.satuan)}` : "Stok habis (DEMO)"}</span>
          <b>${money(product.hargaJual)} <small>/ ${esc(product.satuan)}</small></b>
          <button class="btn-primary" type="button" data-demo-add="${esc(product.sku)}" ${stock <= 0 ? "disabled" : ""}>Tambah ke keranjang</button>
        </div></article>`;
    }).join("") : '<div class="empty"><i class="fa-solid fa-box-open"></i><b>Produk DEMO tidak ditemukan</b><p>Ubah pencarian atau filter kategori.</p></div>';
  }

  function renderCart() {
    $("#demoCartCount").textContent = `${cart.reduce((sum, item) => sum + item.qty, 0)} produk`;
    $("#demoCartTotal").textContent = money(cart.reduce((sum, item) => sum + item.qty * item.price, 0));
    $("#demoCheckoutButton").disabled = !cart.length;
    $("#demoCartItems").innerHTML = cart.length ? cart.map(item => `
      <div class="customer-cart-item"><div><b>${esc(item.name)}</b><small>${money(item.price)} / ${esc(item.unit)}</small></div>
        <div class="qty-control"><button type="button" data-demo-qty="${esc(item.sku)}" data-delta="-1" aria-label="Kurangi">−</button><span>${item.qty}</span><button type="button" data-demo-qty="${esc(item.sku)}" data-delta="1" aria-label="Tambah">+</button></div>
        <button type="button" class="remove-item" data-demo-remove="${esc(item.sku)}" aria-label="Hapus"><i class="fa-solid fa-xmark"></i></button></div>`).join("")
      : '<div class="empty"><i class="fa-solid fa-basket-shopping"></i><b>Keranjang kosong</b><p>Pilih produk DEMO dari katalog.</p></div>';
  }

  function renderOrders() {
    $("#demoOrders").innerHTML = state.orders.length ? `<div class="table-scroll"><table class="data-table">
      <thead><tr><th>NOMOR DEMO</th><th>TANGGAL</th><th>PELANGGAN</th><th>ITEM</th><th>ALAMAT</th><th>TOTAL</th><th>STATUS</th></tr></thead>
      <tbody>${state.orders.map(order => `<tr><td class="bold">${esc(order.number)}</td><td>${new Date(order.date).toLocaleString("id-ID")}</td>
        <td>${esc(order.name)}<br>${esc(order.phone)}</td><td>${order.items.map(item => `${esc(item.name)} × ${item.qty}`).join("<br>")}</td>
        <td>${esc(order.address)}</td><td>${money(order.total)}</td><td><span class="status-pill pending">${esc(order.status)}</span></td></tr>`).join("")}</tbody></table></div>`
      : '<div class="empty"><i class="fa-solid fa-receipt"></i><b>Belum ada pesanan DEMO</b><p>Pesanan simulasi akan tampil di sini setelah checkout.</p></div>';
  }

  function showMessage(message, isError = false) {
    const element = $("#demoCustomerMessage");
    element.textContent = message;
    element.classList.toggle("hidden", !message);
    element.classList.toggle("error", isError);
  }

  function toast(message, isError = false) {
    const element = $("#demoToast");
    element.textContent = message;
    element.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = "toast"; }, 3500);
  }

  function addToCart(sku) {
    const product = products.find(row => row.sku === sku);
    if (!product || available(product) <= 0) return;
    const item = cart.find(row => row.sku === sku);
    if (item && item.qty >= available(product)) {
      toast("Jumlah melebihi stok DEMO yang tersedia.", true);
      return;
    }
    if (item) item.qty += 1;
    else cart.push({ sku, name: product.nama, unit: product.satuan, price: Number(product.hargaJual), qty: 1 });
    renderCart();
  }

  function checkout() {
    try {
      const name = $("#demoRecipientName").value.trim();
      const phone = $("#demoRecipientPhone").value.trim();
      const address = $("#demoDeliveryAddress").value.trim();
      if (!cart.length) throw new Error("Keranjang DEMO masih kosong.");
      if (!name || !phone || !address) throw new Error("Nama penerima, nomor telepon, dan alamat wajib diisi.");
      for (const item of cart) {
        const product = products.find(row => row.sku === item.sku);
        if (!product || item.qty > available(product)) throw new Error(`Stok DEMO ${item.name} tidak mencukupi.`);
      }
      const order = {
        number: `DEMO-${Date.now()}`,
        date: new Date().toISOString(),
        name,
        phone,
        address,
        payment: $("#demoPaymentMethod").value,
        status: "Menunggu (simulasi DEMO)",
        items: cart.map(item => ({ ...item })),
        total: cart.reduce((sum, item) => sum + item.qty * item.price, 0)
      };
      for (const item of cart) state.stock[item.sku] = available(products.find(row => row.sku === item.sku)) - item.qty;
      state.orders.unshift(order);
      saveState();
      cart = [];
      renderCatalog();
      renderCart();
      renderOrders();
      showMessage(`Pesanan ${order.number} dibuat sebagai simulasi lokal. Toko tidak menerima pesanan ini.`);
    } catch (error) {
      showMessage(error.message || "Pesanan DEMO tidak dapat dibuat.", true);
    }
  }

  function init() {
    try {
      state = readStorage(storageKey, { stock: {}, orders: [] });
      if (!state.stock || typeof state.stock !== "object" || !Array.isArray(state.orders)) {
        throw new Error("Struktur data pesanan DEMO tidak valid; data tidak dihapus.");
      }
      const localProducts = readStorage(localProductsKey, []);
      if (!Array.isArray(localProducts)) throw new Error("Daftar produk DEMO lokal tidak valid; data tidak dihapus.");
      products = [...window.RETAIL_DEMO_DATA.products, ...localProducts].map(product => ({
        ...product,
        sku: String(product.sku),
        nama: product.nama,
        hargaJual: Number(product.hargaJual),
        stok: Number(product.stok)
      }));
      const categories = [...new Set(products.map(product => product.kategori).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
      $("#demoCategoryFilter").innerHTML = '<option value="">Semua kategori</option>' + categories.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
      renderCatalog();
      renderCart();
      renderOrders();
    } catch (error) {
      showMessage(error.message || "Data katalog DEMO gagal dimuat.", true);
      $("#demoCheckoutButton").disabled = true;
    }
  }

  $("#demoCatalogSearch").addEventListener("input", renderCatalog);
  $("#demoCategoryFilter").addEventListener("change", renderCatalog);
  $("#demoCatalog").addEventListener("click", event => {
    const button = event.target.closest("[data-demo-add]");
    if (button) addToCart(button.dataset.demoAdd);
  });
  $("#demoCartItems").addEventListener("click", event => {
    const quantity = event.target.closest("[data-demo-qty]");
    const remove = event.target.closest("[data-demo-remove]");
    if (quantity) {
      const item = cart.find(row => row.sku === quantity.dataset.demoQty);
      const product = products.find(row => row.sku === quantity.dataset.demoQty);
      if (item && product) {
        item.qty = Math.max(0, Math.min(available(product), item.qty + Number(quantity.dataset.delta)));
        if (!item.qty) cart = cart.filter(row => row !== item);
        renderCart();
      }
    }
    if (remove) {
      cart = cart.filter(row => row.sku !== remove.dataset.demoRemove);
      renderCart();
    }
  });
  $("#demoCheckoutButton").addEventListener("click", checkout);
  $("#clearDemoCart").addEventListener("click", () => { cart = []; renderCart(); });
  $("#clearDemoOrders").addEventListener("click", () => {
    if (!confirm("Hapus riwayat dan pemakaian stok DEMO lokal? Data toko tidak terpengaruh.")) return;
    state = { stock: {}, orders: [] };
    try {
      saveState();
      renderCatalog();
      renderOrders();
      showMessage("Riwayat dan stok DEMO lokal telah direset. Data Supabase tidak berubah.");
    } catch (error) {
      showMessage(error.message, true);
    }
  });
  document.addEventListener("DOMContentLoaded", init);
})();
