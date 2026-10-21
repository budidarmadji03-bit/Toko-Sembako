(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const money = value => new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const data = window.RETAIL_DEMO_DATA;
  const localProductsKey = "tokoBudiDemoLocalProducts";
  let selectedPhoto = "";

  function localProducts() {
    let rows;
    try {
      rows = JSON.parse(localStorage.getItem(localProductsKey) || "[]");
    } catch {
      throw new Error("Produk DEMO lokal tidak dapat dibaca. Data tidak dihapus; periksa penyimpanan browser.");
    }
    if (!Array.isArray(rows)) throw new Error("Format produk DEMO lokal tidak valid.");
    return rows;
  }

  function allProducts() {
    return [...data.products, ...localProducts()];
  }

  function selectedPurchases() {
    const from = $("#demoFrom").value;
    const to = $("#demoTo").value;
    if (from && to && from > to) throw new Error("Tanggal mulai tidak boleh setelah tanggal akhir.");
    return data.purchases.filter(row => (!from || row.tanggal >= from) && (!to || row.tanggal <= to));
  }

  function renderPurchases() {
    const purchases = selectedPurchases();
    const invoices = new Set(purchases.map(row => row.nota));
    $("#demoInvoiceCount").textContent = invoices.size;
    $("#demoPurchaseCount").textContent = purchases.length;
    $("#demoPurchaseTotal").textContent = money(purchases.reduce((sum, row) => sum + row.total, 0));
    $("#demoPurchasesTable").innerHTML = purchases.length
      ? `<table class="data-table"><thead><tr><th>TANGGAL</th><th>NOTA DEMO</th><th>PEMASOK DEMO</th><th>SKU</th><th>PRODUK DEMO</th><th>JUMLAH</th><th>HARGA/UNIT</th><th>TOTAL DEMO</th></tr></thead><tbody>${purchases.map(row => `<tr><td>${escapeHtml(row.tanggal)}</td><td>${escapeHtml(row.nota)}</td><td>${escapeHtml(row.pemasok)}</td><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.produk)}</td><td>${row.jumlah} ${escapeHtml(row.satuan)}</td><td>${money(row.hargaSatuan)}</td><td class="bold">${money(row.total)}</td></tr>`).join("")}</tbody></table>`
      : '<div class="empty"><i class="fa-solid fa-box-open"></i><b>Tidak ada pembelian DEMO</b><p>Ubah rentang tanggal untuk melihat transaksi simulasi.</p></div>';
  }

  function renderProducts() {
    const products = allProducts();
    $("#demoProductCount").textContent = products.length;
    $("#demoProductsTable").innerHTML = `<table class="data-table"><thead><tr><th>FOTO DEMO</th><th>SKU DEMO</th><th>PRODUK DEMO</th><th>KATEGORI</th><th>HARGA BELI DEMO</th><th>HARGA JUAL DEMO</th><th>STOK DEMO</th><th>MINIMUM DEMO</th></tr></thead><tbody>${products.map(row => `<tr><td>${row.foto ? `<img class="demo-product-thumb" src="${escapeHtml(row.foto)}" alt="Foto ${escapeHtml(row.nama)}">` : "—"}</td><td>${escapeHtml(row.sku)}</td><td class="bold">${escapeHtml(row.nama)}</td><td>${escapeHtml(row.kategori)}</td><td>${money(row.hargaBeli)}</td><td>${money(row.hargaJual)}</td><td>${row.stok} ${escapeHtml(row.satuan)}</td><td>${row.stokMinimum} ${escapeHtml(row.satuan)}</td></tr>`).join("")}</tbody></table>`;
  }

  function compressPhoto(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return Promise.reject(new Error("Format foto harus JPG, PNG, atau WebP."));
    }
    if (file.size > 4 * 1024 * 1024) {
      return Promise.reject(new Error("Ukuran foto maksimal 4 MB."));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Foto tidak dapat dibaca."));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("Berkas foto tidak valid."));
        image.onload = () => {
          const scale = Math.min(1, 800 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Browser tidak dapat memproses foto."));
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const result = canvas.toDataURL("image/jpeg", 0.72);
          if (result.length > 550000) {
            reject(new Error("Foto terlalu besar untuk penyimpanan browser. Pilih foto lain yang lebih kecil."));
            return;
          }
          resolve(result);
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function resetProductForm() {
    $("#demoProductForm").reset();
    $("#demoProductUnit").value = "pcs";
    $("#demoProductStock").value = "0";
    $("#demoProductMin").value = "5";
    $("#demoPhotoPreview").classList.add("hidden");
    $("#demoPhotoPreview").removeAttribute("src");
    $("#demoProductError").classList.add("hidden");
    selectedPhoto = "";
  }

  async function saveLocalProduct(event) {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("#demoProductError").classList.add("hidden");
    try {
      const sku = $("#demoProductSku").value.trim();
      const name = $("#demoProductName").value.trim();
      const category = $("#demoProductCategory").value.trim();
      const unit = $("#demoProductUnit").value.trim();
      const cost = Number($("#demoProductCost").value);
      const price = Number($("#demoProductPrice").value);
      const quantity = Number($("#demoProductStock").value);
      const minimum = Number($("#demoProductMin").value);
      if (!sku || !name || !category || !unit || !selectedPhoto) {
        throw new Error("Lengkapi semua kolom dan pilih foto produk.");
      }
      if ([cost, price, quantity, minimum].some(value => !Number.isFinite(value) || value < 0)) {
        throw new Error("Harga dan jumlah harus berupa angka nol atau lebih.");
      }
      if (allProducts().some(row => String(row.sku).toLowerCase() === sku.toLowerCase())) {
        throw new Error("SKU sudah digunakan pada data DEMO.");
      }
      const record = {
        sku,
        nama: `[DEMO LOKAL] ${name}`,
        kategori: `[DEMO] ${category}`,
        satuan: unit,
        hargaBeli: cost,
        hargaJual: price,
        stok: quantity,
        stokMinimum: minimum,
        foto: selectedPhoto
      };
      const rows = localProducts();
      rows.push(record);
      try {
        localStorage.setItem(localProductsKey, JSON.stringify(rows));
      } catch (error) {
        if (error.name === "QuotaExceededError") {
          throw new Error("Penyimpanan DEMO browser penuh. Hapus beberapa data situs atau pilih foto lebih kecil.");
        }
        throw new Error("Browser menolak penyimpanan produk DEMO lokal.");
      }
      renderProducts();
      $("#demoProductDialog").close();
      resetProductForm();
    } catch (error) {
      $("#demoProductError").textContent = error.message || "Produk DEMO tidak dapat disimpan.";
      $("#demoProductError").classList.remove("hidden");
    } finally {
      submit.disabled = false;
    }
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const rows = selectedPurchases();
    const values = [
      ["DEMO - BUKAN TRANSAKSI RIIL"],
      ["Tanggal", "Nota DEMO", "Pemasok DEMO", "SKU", "Produk DEMO", "Jumlah", "Satuan", "Harga/unit DEMO", "Total DEMO"],
      ...rows.map(row => [row.tanggal, row.nota, row.pemasok, row.sku, row.produk, row.jumlah, row.satuan, row.hargaSatuan, row.total])
    ];
    const blob = new Blob(["\ufeff", values.map(row => row.map(csvCell).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8"
    });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "DEMO-pembelian-14-20-Oktober-2026.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!data || !Array.isArray(data.products) || !Array.isArray(data.purchases)) {
    throw new Error("Data pratinjau DEMO tidak dapat dimuat.");
  }
  renderProducts();
  renderPurchases();
  $("#addDemoProduct").addEventListener("click", () => {
    resetProductForm();
    $("#demoProductDialog").showModal();
  });
  $("#demoProductForm").addEventListener("submit", saveLocalProduct);
  $("#demoProductPhoto").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      selectedPhoto = await compressPhoto(file);
      $("#demoPhotoPreview").src = selectedPhoto;
      $("#demoPhotoPreview").classList.remove("hidden");
    } catch (error) {
      selectedPhoto = "";
      $("#demoProductError").textContent = error.message;
      $("#demoProductError").classList.remove("hidden");
      event.target.value = "";
    }
  });
  $("#cancelDemoProduct").addEventListener("click", () => $("#demoProductDialog").close());
  $("#closeDemoProduct").addEventListener("click", () => $("#demoProductDialog").close());
  $("#applyDemoFilter").addEventListener("click", () => {
    try {
      renderPurchases();
    } catch (error) {
      window.alert(error.message);
    }
  });
  $("#resetDemoFilter").addEventListener("click", () => {
    $("#demoFrom").value = "2026-10-14";
    $("#demoTo").value = "2026-10-20";
    renderPurchases();
  });
  $("#exportDemoCsv").addEventListener("click", () => {
    try {
      exportCsv();
    } catch (error) {
      window.alert(error.message);
    }
  });
})();
