(() => {
  "use strict";

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
  const money = value => new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);

  function print(receipt) {
    if (typeof window.print !== "function") {
      throw new Error("Fitur cetak tidak tersedia pada browser ini. Buka aplikasi di Chrome, Edge, atau Firefox.");
    }
    if (document.querySelector("#retail-print-root")) {
      throw new Error("Nota sedang disiapkan untuk dicetak. Tunggu sebentar lalu coba lagi.");
    }

    const rows = (receipt.items || []).map(item => `
      <tr>
        <td>${escapeHtml(item.name)}<small>${escapeHtml(item.sku || "")}</small></td>
        <td class="number">${Number(item.quantity || 0)} ${escapeHtml(item.unit || "")}</td>
        <td class="number">${money(item.subtotal ?? Number(item.quantity || 0) * Number(item.price || 0))}</td>
      </tr>`).join("");
    const details = [
      ["Pelanggan", receipt.customer],
      ["Pembayaran", receipt.paymentMethod],
      ["Status", receipt.status],
      receipt.deliveryAddress ? ["Alamat antar", receipt.deliveryAddress] : null,
      receipt.deliveryDate ? ["Tanggal kirim", receipt.deliveryDate] : null
    ].filter(Boolean).map(([label, value]) => `
      <div class="detail"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
    const root = document.createElement("section");
    root.id = "retail-print-root";
    root.setAttribute("aria-label", "Nota untuk dicetak");
    root.innerHTML = `
      <header><h1>${escapeHtml(receipt.shopName || "Toko Sembako Budi")}</h1><p>BUKTI TRANSAKSI</p></header>
      <hr class="rule"><div class="detail"><span>Nomor</span><b>${escapeHtml(receipt.invoice)}</b></div>
      <div class="detail"><span>Tanggal</span><b>${escapeHtml(receipt.date)}</b></div>${details}
      <hr class="rule"><table><thead><tr><th>Barang</th><th class="number">Jumlah</th><th class="number">Total</th></tr></thead><tbody>${rows}</tbody></table>
      <hr class="rule"><div class="detail"><span>Subtotal</span><b>${money(receipt.subtotal)}</b></div>
      <div class="detail"><span>Diskon</span><b>${money(receipt.discount)}</b></div>
      <div class="total"><span>Total</span><span>${money(receipt.total)}</span></div>
      <div class="detail"><span>Dibayar</span><b>${money(receipt.paid)}</b></div>
      <div class="detail"><span>Kembalian</span><b>${money(receipt.change)}</b></div>
      <hr class="rule"><p class="muted">${escapeHtml(receipt.footer || "Terima kasih telah berbelanja.")}</p>`;
    const style = document.createElement("style");
    style.id = "retail-print-style";
    style.textContent = `
      #retail-print-root{display:none}
      @media print{
        @page{size:80mm auto;margin:2mm}
        body.retail-printing{margin:0!important;padding:0!important;background:#fff!important}
        body.retail-printing>*:not(#retail-print-root){display:none!important}
        body.retail-printing #retail-print-root{display:block!important;width:76mm;margin:0 auto;padding:6mm 4mm;color:#111;font:12px/1.45 Arial,sans-serif}
        #retail-print-root *{box-sizing:border-box}
        #retail-print-root h1{margin:0;text-align:center;font-size:18px}
        #retail-print-root header p{text-align:center;margin:3px 0 12px}
        #retail-print-root .rule{border:0;border-top:1px dashed #555;margin:9px 0}
        #retail-print-root .detail,#retail-print-root .total{display:flex;justify-content:space-between;gap:10px;margin:3px 0}
        #retail-print-root .detail span{flex:0 0 36%}
        #retail-print-root .detail b{text-align:right;font-weight:500;overflow-wrap:anywhere}
        #retail-print-root table{width:100%;border-collapse:collapse}
        #retail-print-root th{font-weight:600;text-align:left;border-bottom:1px dashed #555;padding:4px 0}
        #retail-print-root td{vertical-align:top;padding:5px 0}
        #retail-print-root td small{display:block;color:#444}
        #retail-print-root .number{text-align:right;white-space:nowrap}
        #retail-print-root .total{font-size:14px;font-weight:700}
        #retail-print-root .muted{text-align:center;color:#444;margin-top:14px}
      }`;
    document.head.append(style);
    document.body.append(root);
    document.body.classList.add("retail-printing");
    const cleanup = () => {
      document.body.classList.remove("retail-printing");
      root.remove();
      style.remove();
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    try {
      window.print();
    } catch (error) {
      window.removeEventListener("afterprint", cleanup);
      cleanup();
      throw new Error(`Browser gagal membuka dialog cetak: ${error.message || "coba muat ulang halaman."}`);
    }
  }

  window.RetailReceipt = { print };
})();
