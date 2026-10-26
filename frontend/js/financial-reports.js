(() => {
  "use strict";

  const TIME_ZONE = "Asia/Jakarta";
  const currency = value => new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const dateInStoreZone = value => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  };
  const dateLabel = value => value
    ? new Intl.DateTimeFormat("id-ID", {
      timeZone: TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value))
    : "—";
  const sum = (rows, selector) => rows.reduce((total, row) => total + selector(row), 0);
  const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const paymentLabel = value => ({
    cash: "Tunai", transfer: "Transfer", qris: "QRIS", debit: "Kartu debit"
  })[value] || value || "Tidak tersedia";
  const textCell = value => {
    const text = String(value ?? "");
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  };
  const excelDateSerial = value => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    let fields;
    if (dateOnly) {
      fields = value.split("-").map(Number);
    } else {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date(value));
      const mapped = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
      fields = [mapped.year, mapped.month, mapped.day, mapped.hour, mapped.minute, mapped.second];
    }
    const [year, month, day, hour = 0, minute = 0, second = 0] = fields;
    if (!year || !month || !day) return value;
    return (Date.UTC(year, month - 1, day, hour, minute, second) - Date.UTC(1899, 11, 30)) / 86400000;
  };

  let callbacks = {};
  let lastModel = null;
  let activeTab = "Ringkasan";
  let loadError = "";
  let isLoading = false;

  function currentPeriod() {
    return {
      from: document.querySelector("#reportFrom")?.value || "",
      to: document.querySelector("#reportTo")?.value || ""
    };
  }

  function makeModel(source, period, filters = {}) {
    const within = value => {
      const date = dateInStoreZone(value);
      return (!period.from || date >= period.from) && (!period.to || date <= period.to);
    };
    const salesByDate = source.sales.filter(row => within(row.tanggal || row.created_at));
    const saleIds = new Set(salesByDate.map(row => String(row.id)));
    const sourceDetails = source.saleItems.filter(row => saleIds.has(String(row.penjualan_id)));
    const productById = new Map(source.products.map(product => [String(product.id), product]));
    const matchesDetail = detail => {
      const product = productById.get(String(detail.barang_id));
      return (!filters.product || String(detail.barang_id) === filters.product) &&
        (!filters.category || product?.kategori === filters.category);
    };
    const hasProductFilter = Boolean(filters.product || filters.category);
    const detailsBySale = new Map();
    for (const detail of sourceDetails) {
      const key = String(detail.penjualan_id);
      detailsBySale.set(key, [...(detailsBySale.get(key) || []), detail]);
    }
    const sales = salesByDate.filter(row =>
      (!filters.customer || String(row.pelanggan_id || "") === filters.customer) &&
      (!filters.payment || row.metode_pembayaran === filters.payment) &&
      (!filters.status || row.status === filters.status) &&
      (!hasProductFilter || (detailsBySale.get(String(row.id)) || []).some(matchesDetail))
    )
      .sort((left, right) => String(right.tanggal || right.created_at).localeCompare(String(left.tanggal || left.created_at)));
    const completed = sales.filter(row => row.status === "selesai" &&
      (!row.status_pembayaran || row.status_pembayaran === "lunas"));
    const purchases = source.purchases.filter(row => within(row.tanggal || row.created_at));
    const expenses = source.expenses.filter(row => within(row.tanggal || row.created_at));
    const movements = source.stockMovements.filter(row => within(row.tanggal || row.created_at));
    const saleIdsForFilter = new Set(sales.map(row => String(row.id)));
    const filteredDetails = sourceDetails.filter(detail => {
      return saleIdsForFilter.has(String(detail.penjualan_id)) && (!hasProductFilter || matchesDetail(detail));
    });
    const details = hasProductFilter ? filteredDetails : sourceDetails.filter(detail => sales.some(row => String(row.id) === String(detail.penjualan_id)));
    const selectedDetailsBySale = new Map();
    for (const detail of details) {
      const key = String(detail.penjualan_id);
      selectedDetailsBySale.set(key, [...(selectedDetailsBySale.get(key) || []), detail]);
    }
    const saleCosts = completed.map(sale => {
      const rows = selectedDetailsBySale.get(String(sale.id)) || [];
      if (!rows.length || rows.some(row => row.harga_pokok_satuan == null)) return null;
      return sum(rows, row => Number(row.jumlah) * Number(row.harga_pokok_satuan));
    });
    const costsComplete = saleCosts.every(value => value !== null);
    const selectedSubtotal = sale => {
      if (!hasProductFilter) return Number(sale.subtotal || 0);
      return sum(selectedDetailsBySale.get(String(sale.id)) || [], detail =>
        Number(detail.subtotal ?? Number(detail.jumlah || 0) * Number(detail.harga_satuan || 0)));
    };
    const allocatedDiscount = sale => {
      if (!hasProductFilter) return Number(sale.diskon || 0);
      const fullSubtotal = Number(sale.subtotal || 0);
      return fullSubtotal > 0 ? Number((Number(sale.diskon || 0) * selectedSubtotal(sale) / fullSubtotal).toFixed(2)) : 0;
    };
    const subtotal = sum(completed, selectedSubtotal);
    const discount = sum(completed, allocatedDiscount);
    const salesTotalsConsistent = completed.every(row =>
      roundMoney(roundMoney(row.subtotal) - roundMoney(row.diskon)) === roundMoney(row.total)
    );
    const netSales = salesTotalsConsistent
      ? (hasProductFilter
        ? sum(completed, sale => selectedSubtotal(sale) - allocatedDiscount(sale))
        : subtotal - discount)
      : null;
    const cogs = costsComplete ? sum(saleCosts, value => value) : null;
    const expenseTotal = sum(expenses, row => Number(row.nominal || 0));
    const grossProfit = cogs === null ? null : netSales - cogs;
    const salesFiltered = Boolean(filters.product || filters.category || filters.customer || filters.payment || filters.status);
    const netProfit = grossProfit === null || salesFiltered ? null : grossProfit - expenseTotal;
    const products = source.products.map(product => ({
      ...product,
      value: Number(product.stok || 0) * Number(product.harga_beli || 0)
    })).sort((left, right) => right.value - left.value);
    const inventoryTotal = sum(products, row => row.value);
    const productTotals = new Map();
    for (const sale of completed) {
      const rows = selectedDetailsBySale.get(String(sale.id)) || [];
      const saleSubtotal = selectedSubtotal(sale);
      const discountForRows = allocatedDiscount(sale);
      let allocatedSoFar = 0;
      rows.forEach((detail, index) => {
        const key = String(detail.barang_id || detail.sku || detail.nama_barang);
        const line = Number(detail.subtotal ?? Number(detail.jumlah || 0) * Number(detail.harga_satuan || 0));
        const discountShare = index === rows.length - 1
          ? discountForRows - allocatedSoFar
          : saleSubtotal > 0 ? roundMoney(discountForRows * line / saleSubtotal) : 0;
        allocatedSoFar += discountShare;
        const bucket = productTotals.get(key) || {
          sku: detail.sku || "",
          name: detail.nama_barang || "Barang",
          quantity: 0,
          gross: 0,
          net: 0,
          cost: 0,
          costComplete: true
        };
        bucket.quantity += Number(detail.jumlah || 0);
        bucket.gross += line;
        bucket.net += line - discountShare;
        if (detail.harga_pokok_satuan == null) bucket.costComplete = false;
        else bucket.cost += Number(detail.jumlah || 0) * Number(detail.harga_pokok_satuan);
        productTotals.set(key, bucket);
      });
    }
    const payments = [
      ["cash", "Tunai"], ["transfer", "Transfer"], ["qris", "QRIS"], ["debit", "Kartu debit"]
    ].map(([key, label]) => {
      const rows = completed.filter(sale => sale.metode_pembayaran === key);
      return {
        label,
        count: rows.length,
        total: !salesTotalsConsistent
          ? null
          : hasProductFilter
          ? sum(rows, sale => selectedSubtotal(sale) - allocatedDiscount(sale))
          : sum(rows, sale => Number(sale.total || 0))
      };
    }).filter(row => row.count);
    return {
      period, sales, completed, purchases, expenses, movements, details, detailsBySale: selectedDetailsBySale,
      products, inventoryTotal, subtotal, discount, netSales, costsComplete, cogs,
      grossProfit, expenseTotal, netProfit, saleCosts,
      salesTotalsConsistent,
      averageTransaction: completed.length ? netSales / completed.length : 0,
      cancelledCount: sales.filter(row => row.status === "dibatalkan").length,
      salesFiltered,
      filters,
      productTotals: [...productTotals.values()].map(row => ({
        ...row,
        margin: row.costComplete ? row.net - row.cost : null
      })).sort((left, right) => right.net - left.net),
      payments
    };
  }

  function makeAccountingModel(source, period) {
    const accounting = source.accounting || {};
    if (accounting.error || !accounting.settings) {
      return { error: accounting.error || "Data jurnal belum tersedia." };
    }
    const accounts = accounting.accounts || [];
    const entries = accounting.entries || [];
    const lines = accounting.lines || [];
    const payments = accounting.payments || [];
    const reconciliations = accounting.reconciliations || [];
    const accountById = new Map(accounts.map(account => [String(account.id), account]));
    const entryById = new Map(entries.map(entry => [String(entry.id), entry]));
    const linesByEntry = new Map();
    const linesByAccount = new Map();
    for (const line of lines) {
      const entryId = String(line.journal_entry_id);
      const accountId = String(line.account_id);
      linesByEntry.set(entryId, [...(linesByEntry.get(entryId) || []), line]);
      linesByAccount.set(accountId, [...(linesByAccount.get(accountId) || []), line]);
    }
    const endDate = period.to || dateInStoreZone(new Date());
    const cutoverDate = accounting.settings.cutover_date;
    const startDate = period.from && period.from > cutoverDate ? period.from : cutoverDate;
    const entryAtEnd = entries.filter(entry => entry.entry_date <= endDate);
    const entryInPeriod = entryAtEnd.filter(entry => entry.entry_date >= startDate);
    const balance = (account, beforeDate = null, exclusive = false) => sum(
      (linesByAccount.get(String(account.id)) || []).filter(line => {
        const entry = entryById.get(String(line.journal_entry_id));
        return entry && (exclusive ? entry.entry_date < beforeDate : entry.entry_date <= (beforeDate || endDate));
      }),
      line => Number(line.debit || 0) - Number(line.credit || 0)
    );
    const normalBalance = (account, beforeDate = null, exclusive = false) => {
      const net = balance(account, beforeDate, exclusive);
      return account.normal_balance === "credit" ? -net : net;
    };
    const assets = accounts.filter(account => account.account_type === "asset")
      .map(account => ({ ...account, amount: normalBalance(account) }));
    const liabilities = accounts.filter(account => account.account_type === "liability")
      .map(account => ({ ...account, amount: normalBalance(account) }));
    const equityAccounts = accounts.filter(account => account.account_type === "equity")
      .map(account => ({ ...account, amount: account.normal_balance === "credit"
        ? normalBalance(account) : -normalBalance(account) }));
    const profitToDate = sum(lines.filter(line => {
      const entry = entryById.get(String(line.journal_entry_id));
      const account = accountById.get(String(line.account_id));
      return entry && entry.entry_date <= endDate &&
        ["revenue", "contra_revenue", "expense"].includes(account?.account_type);
    }), line => Number(line.credit || 0) - Number(line.debit || 0));
    const profitAndLossRows = accounts.filter(account =>
      ["revenue", "contra_revenue", "expense"].includes(account.account_type)
    ).map(account => ({
      ...account,
      amount: sum((linesByAccount.get(String(account.id)) || []).filter(line => {
        const entry = entryById.get(String(line.journal_entry_id));
        return entry && entry.entry_date >= startDate && entry.entry_date <= endDate;
      }), line => Number(line.credit || 0) - Number(line.debit || 0))
    }));
    const equityTotal = sum(equityAccounts, account => account.amount) + profitToDate;
    const assetTotal = sum(assets, account => account.amount);
    const liabilityTotal = sum(liabilities, account => account.amount);
    const balanceDifference = roundMoney(assetTotal - liabilityTotal - equityTotal);
    const allBalanced = entries.every(entry => {
      const entryLines = linesByEntry.get(String(entry.id)) || [];
      return entryLines.length >= 2 &&
        Math.abs(sum(entryLines, line => Number(line.debit || 0)) -
          sum(entryLines, line => Number(line.credit || 0))) <= 0.005;
    });
    const cashAccounts = accounts.filter(account => account.is_cash_equivalent);
    const cashMovement = new Map();
    const cashByMethod = new Map();
    for (const entry of entryInPeriod) {
      const entryLines = linesByEntry.get(String(entry.id)) || [];
      const net = sum(entryLines.filter(line =>
        accountById.get(String(line.account_id))?.is_cash_equivalent
      ), line => Number(line.debit || 0) - Number(line.credit || 0));
      const activity = entry.cash_flow_activity || "operating";
      const totals = cashMovement.get(activity) || { inflow: 0, outflow: 0 };
      if (net >= 0) totals.inflow += net;
      else totals.outflow += Math.abs(net);
      cashMovement.set(activity, totals);
    }
    const periodPayments = payments.filter(payment =>
      payment.payment_date >= startDate && payment.payment_date <= endDate
    );
    for (const payment of periodPayments) {
      const methodTotals = cashByMethod.get(payment.payment_method) || { inflow: 0, outflow: 0 };
      const incoming = ["customer_receipt"].includes(payment.kind);
      if (incoming) methodTotals.inflow += Number(payment.amount);
      else methodTotals.outflow += Number(payment.amount);
      cashByMethod.set(payment.payment_method, methodTotals);
    }
    const activityRows = ["operating", "investing", "financing"].map(activity => ({
      activity,
      ...(cashMovement.get(activity) || { inflow: 0, outflow: 0 }),
      net: (cashMovement.get(activity)?.inflow || 0) - (cashMovement.get(activity)?.outflow || 0)
    }));
    const netCashChange = sum(activityRows, row => row.net);
    const openingEntry = entryById.get(String(accounting.settings.opening_entry_id));
    const hasOpening = Boolean(openingEntry && openingEntry.entry_date <= endDate);
    const openingLines = (linesByEntry.get(String(accounting.settings.opening_entry_id)) || [])
      .filter(line => accountById.get(String(line.account_id))?.is_cash_equivalent);
    const openingCash = !hasOpening ? null : startDate === cutoverDate
      ? sum(openingLines, line => Number(line.debit || 0) - Number(line.credit || 0))
      : sum(cashAccounts, account => normalBalance(account, startDate, true));
    const balanceAccounts = [...assets, ...liabilities, ...equityAccounts];
    const cashEnding = sum(cashAccounts, account => normalBalance(account));
    const inventoryAccount = accounts.find(account => account.code === "1040");
    const inventoryLedger = inventoryAccount ? normalBalance(inventoryAccount) : null;
    const availableInventory = sum((source.products || []).map(product => ({
      value: Number(product.stok || 0) * Number(product.harga_beli || 0)
    })), product => product.value);
    const reservedSaleIds = new Set((source.sales || []).filter(sale =>
      ["menunggu", "diproses", "dalam_pengiriman"].includes(sale.status)
    ).map(sale => String(sale.id)));
    const reservedInventory = sum((source.saleItems || []).filter(item =>
      reservedSaleIds.has(String(item.penjualan_id))
    ), item => Number(item.jumlah || 0) * Number(item.harga_pokok_satuan || 0));
    const inventoryActual = availableInventory + reservedInventory;
    const today = dateInStoreZone(new Date());
    const inventoryComparable = endDate === today;
    const inventoryDifference = inventoryComparable && inventoryLedger !== null
      ? roundMoney(inventoryActual - inventoryLedger) : null;
    const reconciliationRows = cashAccounts.map(account => {
      const latest = reconciliations
        .filter(row => String(row.account_id) === String(account.id) && row.statement_date <= endDate)
        .sort((left, right) => right.statement_date.localeCompare(left.statement_date))[0];
      const bookAmount = normalBalance(account);
      return {
        account: account.name,
        statementDate: latest?.statement_date || null,
        statementBalance: latest ? Number(latest.statement_balance) : null,
        bookAmount,
        difference: latest && latest.statement_date === endDate
          ? roundMoney(Number(latest.statement_balance) - bookAmount) : null
      };
    });
    const paymentPostingDifference = sum(periodPayments, payment => {
      const entry = entryById.get(String(payment.journal_entry_id));
      if (!entry) return Number(payment.amount);
      const entryLines = linesByEntry.get(String(entry.id)) || [];
      const cashNet = sum(entryLines.filter(line => String(line.account_id) === String(payment.cash_account_id)),
        line => Number(line.debit || 0) - Number(line.credit || 0));
      const expected = payment.kind === "customer_receipt" ? Number(payment.amount) : -Number(payment.amount);
      return Math.abs(cashNet - expected) <= 0.005 ? 0 : cashNet - expected;
    });
    const accountRows = accounts.filter(account => balanceAccounts.some(row => row.id === account.id))
      .map(account => ({ ...account, amount: account.account_type === "equity"
        ? account.normal_balance === "credit" ? normalBalance(account) : -normalBalance(account)
        : normalBalance(account) }));
    return {
      error: "",
      accounts, entries, lines, payments, startDate, endDate, cutoverDate,
      hasOpening, allBalanced, balanceDifference, assets, liabilities, equityAccounts,
      assetTotal, liabilityTotal, equityTotal, profitToDate, profitAndLossRows, cashAccounts,
      openingCash: hasOpening ? openingCash : null,
      cashEnding: hasOpening ? cashEnding : null,
      activityRows, netCashChange,
      cashByMethod: [...cashByMethod.entries()].map(([method, totals]) => ({ method, ...totals })),
      inventoryActual, inventoryLedger, inventoryComparable, inventoryDifference,
      reconciliationRows, paymentPostingDifference,
      balanceSheetBalances: accountRows
    };
  }

  function table(rows, headings, renderRow, emptyMessage) {
    if (!rows.length) return `<div class="empty"><b>${escapeHtml(emptyMessage)}</b></div>`;
    return `<table class="data-table"><thead><tr>${headings.map(value => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.map(renderRow).join("")}</tbody></table>`;
  }

  function updateFilterOptions(source) {
    const options = [
      ["#reportProductFilter", "Semua barang", [...new Map(source.products.map(row => [String(row.id), row])).values()]
        .map(row => [row.id, `${row.sku || ""} — ${row.nama || "Barang"}`])],
      ["#reportCategoryFilter", "Semua kategori", [...new Set(source.products.map(row => row.kategori).filter(Boolean))]
        .sort().map(value => [value, value])],
      ["#reportCustomerFilter", "Semua pelanggan", source.customers.map(row => [row.id, row.nama])],
      ["#reportPaymentFilter", "Semua metode", [["cash", "Tunai"], ["transfer", "Transfer"], ["qris", "QRIS"], ["debit", "Kartu debit"]]],
      ["#reportStatusFilter", "Semua status", [["selesai", "Selesai"], ["dibatalkan", "Dibatalkan"], ["menunggu", "Menunggu"], ["diproses", "Diproses"], ["dalam_pengiriman", "Dalam pengiriman"], ["gagal_dikirim", "Gagal dikirim"]]]
    ];
    for (const [selector, placeholder, values] of options) {
      const select = document.querySelector(selector);
      if (!select) continue;
      const selected = select.value;
      select.innerHTML = `<option value="">${placeholder}</option>${values.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}`;
      if (values.some(([value]) => String(value) === selected)) select.value = selected;
    }
  }

  function setReportError(error) {
    loadError = String(error || "Data laporan tidak dapat dimuat.");
    isLoading = false;
    const notice = document.querySelector("#reportDataError");
    if (notice) {
      notice.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span><strong>Laporan tidak diperbarui.</strong> ${escapeHtml(loadError)} Muat ulang data sebelum menggunakan angka laporan.</span>`;
      notice.classList.remove("hidden");
    }
    document.querySelectorAll("#page-reports .report-totals b").forEach(node => node.textContent = "Data gagal dimuat");
    document.querySelectorAll("#page-reports .report-totals small").forEach(node => node.textContent = "Angka tidak tersedia");
    document.querySelector("#page-reports .report-tabs")?.classList.add("hidden");
    document.querySelectorAll("#page-reports .report-totals").forEach(node => node.classList.add("hidden"));
    ["#incomeStatement", "#paymentBreakdown", "#productPerformance", "#salesTable",
      "#purchasesTable", "#expensesTable", "#stockMovementsTable", "#inventoryValuation"]
      .forEach(selector => document.querySelector(selector)?.closest(".panel")?.classList.add("hidden"));
    ["#exportSales", "#exportSalesExcel", "#exportPackageExcel"].forEach(selector => {
      const button = document.querySelector(selector);
      if (button) button.disabled = true;
    });
  }

  function setReportLoading() {
    isLoading = true;
    const notice = document.querySelector("#reportDataError");
    if (notice) {
      notice.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Memuat ulang data laporan...</span>';
      notice.classList.remove("hidden");
    }
    document.querySelector("#page-reports .report-tabs")?.classList.add("hidden");
    document.querySelectorAll("#page-reports .report-totals").forEach(node => node.classList.add("hidden"));
    ["#incomeStatement", "#paymentBreakdown", "#productPerformance", "#salesTable",
      "#purchasesTable", "#expensesTable", "#stockMovementsTable", "#inventoryValuation"]
      .forEach(selector => document.querySelector(selector)?.closest(".panel")?.classList.add("hidden"));
    ["#exportSales", "#exportSalesExcel", "#exportPackageExcel"].forEach(selector => {
      const button = document.querySelector(selector);
      if (button) button.disabled = true;
    });
  }

  function render(source) {
    if (loadError || isLoading) return;
    const period = currentPeriod();
    if (period.from && period.to && period.from > period.to) {
      callbacks.notify("Tanggal mulai tidak boleh setelah tanggal akhir.", true);
      return;
    }
    updateFilterOptions(source);
    const filters = {
      product: document.querySelector("#reportProductFilter")?.value || "",
      category: document.querySelector("#reportCategoryFilter")?.value || "",
      customer: document.querySelector("#reportCustomerFilter")?.value || "",
      payment: document.querySelector("#reportPaymentFilter")?.value || "",
      status: document.querySelector("#reportStatusFilter")?.value || ""
    };
    const model = {
      ...makeModel(source, period, filters),
      accounting: makeAccountingModel(source, period)
    };
    const accounting = model.accounting.error
      ? { ...model.accounting, payments: [] }
      : model.accounting;
    lastModel = model;
    document.querySelector("#page-reports .report-tabs")?.classList.remove("hidden");
    document.querySelectorAll("#page-reports .report-totals").forEach(node => node.classList.remove("hidden"));
    ["#incomeStatement", "#paymentBreakdown", "#productPerformance", "#salesTable",
      "#purchasesTable", "#expensesTable", "#stockMovementsTable", "#inventoryValuation"]
      .forEach(selector => document.querySelector(selector)?.closest(".panel")?.classList.remove("hidden"));
    const setText = (selector, value) => {
      const element = document.querySelector(selector);
      if (element) element.textContent = value;
    };
    const display = value => value === null ? "Data belum lengkap" : currency(value);
    const saleCount = document.querySelector("#reportCount");
    setText("#reportRevenue", display(model.netSales));
    setText("#reportCost", display(model.cogs));
    setText("#reportGrossProfit", display(model.grossProfit));
    setText("#reportExpenses", currency(model.expenseTotal));
    setText("#reportNetProfit", accounting.error
      ? display(model.netProfit)
      : currency(sum(accounting.profitAndLossRows, row => row.amount)));
    setText("#reportDiscount", currency(model.discount));
    setText("#reportGrossSales", currency(model.subtotal));
    setText("#reportAverage", display(model.netSales === null ? null : model.averageTransaction));
    setText("#reportInventoryValue", currency(model.inventoryTotal));
    setText("#reportCanceledCount", String(model.cancelledCount));
    if (saleCount) saleCount.textContent = String(model.completed.length);
    setText("#reportCashflow", model.accounting.error
      ? "Migrasi belum dijalankan"
      : model.accounting.hasOpening ? currency(model.accounting.netCashChange) : "Saldo awal belum dicatat");
    setText("#reportPurchases", currency(sum(model.purchases, row => Number(row.total ?? Number(row.jumlah || 0) * Number(row.harga_satuan || 0)))));

    const costNotice = document.querySelector("#legacyCostNotice");
    if (costNotice) costNotice.classList.toggle("hidden", model.costsComplete);
    const periodLabel = document.querySelector("#reportPeriodLabel");
    if (periodLabel) periodLabel.textContent = `Periode: ${model.period.from || "awal data"} s.d. ${model.period.to || "hari ini"} · Zona waktu ${TIME_ZONE}${model.salesTotalsConsistent ? "" : " · PERINGATAN: total nota tidak sama dengan subtotal - diskon"}`;
    const filterNote = document.querySelector("#reportFilterNote");
    if (filterNote) filterNote.textContent = model.salesFiltered
      ? "Filter transaksi aktif. Beban operasional tetap menjumlahkan seluruh catatan pada periode; laba bersih tidak ditampilkan karena beban tidak dapat dialokasikan ke filter penjualan."
      : "";
    const errorNotice = document.querySelector("#reportDataError");
    if (errorNotice) errorNotice.classList.add("hidden");

    const legacyIncomeRows = [
      ["Penjualan bruto", model.subtotal],
      ["Diskon penjualan", -model.discount],
      ["Retur / refund", "Tidak tersedia"],
      ["Penjualan tercatat setelah diskon (belum dikurangi retur)", model.netSales],
      ["HPP snapshot", model.cogs === null ? "Tidak tersedia" : -model.cogs],
      ["Laba kotor tercatat (belum dikurangi retur)", model.grossProfit === null ? "Tidak tersedia" : model.grossProfit],
      [model.salesFiltered ? "Beban periode (tidak dialokasikan ke filter penjualan)" : "Beban operasional tercatat", model.salesFiltered ? "Tidak tersedia untuk alokasi" : -model.expenseTotal],
      ["Laba bersih tercatat sebelum pajak (belum dikurangi retur)", model.netProfit === null ? "Tidak tersedia" : model.netProfit],
      ["Pendapatan nonoperasional", "Tidak tersedia"],
      ["Beban nonoperasional", "Tidak tersedia"],
      ["Laba/rugi sebelum pajak", model.netProfit === null ? "Tidak tersedia" : model.netProfit],
      ["Pajak penghasilan", "Tidak tersedia"]
    ];
    const incomeRows = accounting.error ? legacyIncomeRows : [
      ...accounting.profitAndLossRows.map(row => [`${row.code} — ${row.name}`, row.amount]),
      ["Laba/rugi bersih jurnal pada periode", sum(accounting.profitAndLossRows, row => row.amount)]
    ];
    const incomeNode = document.querySelector("#incomeStatement");
    if (incomeNode) incomeNode.innerHTML = table(incomeRows, ["Keterangan", "Nominal"], row =>
      `<tr><td class="${row[0].includes("tercatat") ? "bold" : ""}">${escapeHtml(row[0])}</td><td>${row[1] == null ? "Tidak tersedia" : typeof row[1] === "number" ? currency(row[1]) : escapeHtml(String(row[1]))}</td></tr>`,
    "Belum ada transaksi pada periode ini");
    const incomeHeading = document.querySelector("#incomeStatement")?.closest(".panel")?.querySelector(".panel-head p");
    if (incomeHeading) incomeHeading.textContent = accounting.error
      ? "Ringkasan operasional provisional; jalankan migrasi ledger untuk laporan laba rugi jurnal."
      : `Berdasarkan jurnal yang diposting ${accounting.startDate} s.d. ${accounting.endDate}. Data sebelum ${accounting.cutoverDate} tidak direkonstruksi.`;

    const paymentNode = document.querySelector("#paymentBreakdown");
    if (paymentNode) paymentNode.innerHTML = table(model.payments, ["Metode pada nota", "Transaksi selesai", "Nilai penjualan"], row =>
      `<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td><td>${row.total === null ? "Tidak tersedia" : currency(row.total)}</td></tr>`,
    "Belum ada penjualan selesai");

    const cashFlowRows = accounting.error ? [] : [
      ["Saldo kas/bank awal", accounting.openingCash],
      ...accounting.activityRows.map(row => [
        ({ operating: "Aktivitas operasi", investing: "Aktivitas investasi", financing: "Aktivitas pendanaan" })[row.activity],
        `${currency(row.inflow)} masuk · ${currency(row.outflow)} keluar · neto ${currency(row.net)}`
      ]),
      ["Perubahan kas/bank", accounting.netCashChange],
      ["Saldo kas/bank akhir", accounting.cashEnding]
    ];
    const cashFlowNode = document.querySelector("#cashFlowStatementTable");
    if (cashFlowNode) cashFlowNode.innerHTML = accounting.error
      ? `<div class="report-limitation">${escapeHtml(accounting.error)}</div>`
      : table(cashFlowRows, ["Arus kas", "Nominal (Rp)"], row =>
        `<tr><td>${escapeHtml(row[0])}</td><td>${typeof row[1] === "number" ? currency(row[1]) : escapeHtml(row[1] ?? "Tidak tersedia")}</td></tr>`,
      "Belum ada jurnal kas/bank pada periode ini");
    const cashMethodRows = accounting.error ? [] : accounting.cashByMethod.map(row => ({
      method: paymentLabel(row.method), inflow: row.inflow, outflow: row.outflow
    }));
    if (cashFlowNode && !accounting.error) {
      cashFlowNode.insertAdjacentHTML("beforeend", `<div class="section-gap">${table(cashMethodRows,
        ["Metode penyelesaian", "Kas/bank masuk", "Kas/bank keluar"],
        row => `<tr><td>${escapeHtml(row.method)}</td><td>${currency(row.inflow)}</td><td>${currency(row.outflow)}</td></tr>`,
        "Tidak ada pembayaran pada periode ini")}</div>`);
    }
    const cashWarning = document.querySelector("#cashFlowStatementWarning");
    if (cashWarning) {
      cashWarning.classList.toggle("hidden", Boolean(accounting.error));
      cashWarning.textContent = accounting.error || (accounting.hasOpening
        ? "QRIS dan kartu debit dicatat ke Bank pada tanggal transaksi sesuai kebijakan yang dipilih. Saldo awal perlu diverifikasi; saldo akhir yang dilaporkan adalah saldo buku, bukan rekening koran."
        : "Arus transaksi tercatat ditampilkan, tetapi saldo awal dan saldo akhir tidak tersedia sampai Owner memasukkan saldo awal terverifikasi. Tidak ada transaksi lama yang ditebak.");
    }
    const balanceRows = accounting.error ? [] : [
      ...accounting.assets.map(row => ["Aset", row.code, row.name, row.amount]),
      ["TOTAL ASET", "", "", accounting.assetTotal],
      ...accounting.liabilities.map(row => ["Liabilitas", row.code, row.name, row.amount]),
      ["TOTAL LIABILITAS", "", "", accounting.liabilityTotal],
      ...accounting.equityAccounts.map(row => ["Ekuitas", row.code, row.name, row.amount]),
      ["Ekuitas periode berjalan", "", "Laba/rugi kumulatif setelah cutover", accounting.profitToDate],
      ["TOTAL LIABILITAS + EKUITAS", "", "", accounting.liabilityTotal + accounting.equityTotal],
      ["SELISIH NERACA", "", "", accounting.balanceDifference]
    ];
    const balanceNode = document.querySelector("#balanceSheetTable");
    if (balanceNode) balanceNode.innerHTML = accounting.error
      ? `<div class="report-limitation">${escapeHtml(accounting.error)}</div>`
      : table(balanceRows, ["Kelompok", "Kode", "Akun", "Saldo (Rp)"], row =>
        `<tr class="${String(row[0]).startsWith("TOTAL") || row[0] === "SELISIH NERACA" ? "bold" : ""}"><td>${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td><td>${escapeHtml(row[2])}</td><td>${currency(row[3])}</td></tr>`,
      "Belum ada saldo buku pada tanggal laporan");
    const balanceWarning = document.querySelector("#balanceSheetWarning");
    if (balanceWarning) {
      const warnings = [];
      if (accounting.error) warnings.push(accounting.error);
      else {
        if (!accounting.hasOpening) warnings.push("Saldo awal belum dicatat; nilai tidak mencerminkan aset, utang, atau modal sebelum tanggal cutover.");
        if (!accounting.allBalanced) warnings.push("Ditemukan jurnal tidak seimbang; hentikan penggunaan laporan dan periksa data.");
        if (Math.abs(accounting.balanceDifference) > 0.01) warnings.push(`Selisih aset terhadap liabilitas dan ekuitas: ${currency(accounting.balanceDifference)}.`);
      }
      balanceWarning.classList.toggle("hidden", warnings.length === 0);
      balanceWarning.textContent = warnings.join(" ");
    }
    const reconcileRows = accounting.error ? [] : [
      ["Saldo awal terverifikasi", accounting.hasOpening ? "Dicatat pada tanggal cutover" : "Belum dicatat"],
      ["Keseimbangan seluruh jurnal", accounting.allBalanced ? "Seimbang" : "ADA JURNAL TIDAK SEIMBANG"],
      ["Selisih total debit-kredit neraca", currency(accounting.balanceDifference)],
      ["Jurnal pembayaran dibanding sumber", Math.abs(accounting.paymentPostingDifference) <= 0.01
        ? "Cocok" : `Selisih ${currency(accounting.paymentPostingDifference)}`],
      ["Nilai persediaan pada buku", accounting.inventoryLedger === null ? "Tidak tersedia" : currency(accounting.inventoryLedger)],
      ["Estimasi nilai stok saat ini", accounting.inventoryComparable ? currency(accounting.inventoryActual) : "Tanggal laporan bukan hari ini"],
      ["Selisih stok terhadap buku", accounting.inventoryDifference === null
        ? "Belum dapat dibandingkan" : currency(accounting.inventoryDifference)],
      ...accounting.reconciliationRows.map(row => [
        `Kas/bank: ${row.account}`,
        row.statementDate === accounting.endDate && row.difference !== null
          ? `${row.statementDate}: selisih ${currency(row.difference)}`
          : row.statementDate ? `Rekening koran terakhir ${row.statementDate}; saldo akhir ${accounting.endDate} belum direkonsiliasi`
            : "Belum ada saldo rekening koran terverifikasi"
      ])
    ];
    const reconciliationNode = document.querySelector("#accountingReconciliationTable");
    if (reconciliationNode) reconciliationNode.innerHTML = accounting.error
      ? `<div class="report-limitation">${escapeHtml(accounting.error)}</div>`
      : table(reconcileRows, ["Pemeriksaan", "Hasil"], row =>
        `<tr><td>${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td></tr>`,
      "Belum ada data rekonsiliasi");
    const reconciliationWarning = document.querySelector("#accountingReconciliationWarning");
    if (reconciliationWarning) {
      const issues = [];
      if (!accounting.error && !accounting.hasOpening) issues.push("Saldo awal belum tersedia.");
      if (!accounting.error && !accounting.allBalanced) issues.push("Ada jurnal tidak seimbang.");
      if (!accounting.error && accounting.inventoryDifference !== null && Math.abs(accounting.inventoryDifference) > 0.01) {
        issues.push("Nilai stok dan akun persediaan berbeda; periksa mutasi/biaya dan jangan buat jurnal penyeimbang otomatis.");
      }
      if (!accounting.error && accounting.reconciliationRows.some(row => row.difference !== null && Math.abs(row.difference) > 0.01)) {
        issues.push("Saldo buku berbeda dari saldo rekening koran yang dicatat.");
      }
      if (!accounting.error && accounting.reconciliationRows.some(row => row.difference === null)) {
        issues.push("Saldo kas/bank eksternal belum direkonsiliasi pada tanggal akhir laporan.");
      }
      reconciliationWarning.classList.toggle("hidden", issues.length === 0);
      reconciliationWarning.textContent = accounting.error || issues.join(" ");
    }
    document.querySelector("#openOpeningBalances")?.toggleAttribute("disabled", Boolean(accounting.error || accounting.hasOpening));
    document.querySelector("#openManualJournal")?.toggleAttribute("disabled", Boolean(accounting.error));
    document.querySelector("#openCashReconciliation")?.toggleAttribute("disabled", Boolean(accounting.error));

    const saleRows = model.sales.flatMap(sale => {
      const customer = source.customers.find(row => String(row.id) === String(sale.pelanggan_id));
      const details = model.detailsBySale.get(String(sale.id)) || [];
      return (details.length ? details : [null]).map((detail, index) => ({
        sale,
        customer: customer?.nama || sale.recipient_name || "Pelanggan umum",
        detail,
        firstLine: index === 0,
        unit: detail ? source.products.find(product => String(product.id) === String(detail.barang_id))?.satuan || "Tidak tersedia" : "Tidak tersedia",
        settlementKnown: (accounting.entries || []).some(entry =>
          entry.source_type === "sale" && String(entry.source_id) === String(sale.id) &&
          entry.entry_type === "sale"
        ),
        received: sum(accounting.payments.filter(payment => payment.kind === "customer_receipt" &&
          String(payment.source_id) === String(sale.id)), payment => Number(payment.amount)),
        refunded: sum(accounting.payments.filter(payment => payment.kind === "customer_refund" &&
          String(payment.source_id) === String(sale.id)), payment => Number(payment.amount))
      }));
    });
    const salesNode = document.querySelector("#salesTable");
    if (salesNode) salesNode.innerHTML = table(saleRows,
      ["Nota", "Tanggal", "Pelanggan", "Kasir", "Produk", "Qty", "Satuan", "Harga", "HPP snapshot", "Diskon nota", "Total nota", "Metode", "Dibayar", "Sisa tagihan", "Status pembayaran", "Status transaksi", "Aksi"],
      row => {
        const outstanding = row.settlementKnown
          ? Math.max(0, Number(row.sale.total || 0) - row.received) : null;
        const refundDue = Math.max(0, row.received - row.refunded);
        const paymentAction = row.settlementKnown && !accounting.error && row.sale.status === "selesai" && outstanding > 0
          ? `<button class="table-action" data-record-customer-payment="${escapeHtml(row.sale.id)}" data-payment-balance="${outstanding}" title="Catat pembayaran piutang"><i class="fa-solid fa-money-bill-transfer"></i></button>` : "";
        const refundAction = row.settlementKnown && !accounting.error && row.sale.status === "dibatalkan" && refundDue > 0
          ? `<button class="table-action" data-record-customer-refund="${escapeHtml(row.sale.id)}" data-payment-balance="${refundDue}" title="Catat pengembalian dana"><i class="fa-solid fa-rotate-left"></i></button>` : "";
        return `<tr><td>${escapeHtml(row.sale.nomor_nota || "—")}</td><td>${escapeHtml(dateLabel(row.sale.tanggal || row.sale.created_at))}</td><td>${escapeHtml(row.customer)}</td><td>Tidak tersedia</td><td>${escapeHtml(row.detail?.nama_barang || "—")}</td><td>${row.detail ? Number(row.detail.jumlah || 0) : "—"}</td><td>${escapeHtml(row.unit)}</td><td>${row.detail ? currency(row.detail.harga_satuan) : "Tidak tersedia"}</td><td>${row.detail?.harga_pokok_satuan == null ? "Tidak tersedia" : currency(Number(row.detail.jumlah) * Number(row.detail.harga_pokok_satuan))}</td><td>${row.firstLine ? currency(row.sale.diskon) : "—"}</td><td>${row.firstLine ? currency(row.sale.total) : "—"}</td><td>${row.firstLine ? escapeHtml(paymentLabel(row.sale.metode_pembayaran)) : "—"}</td><td>${row.firstLine ? row.settlementKnown ? currency(row.received) : "Tidak tersedia (historis)" : "—"}</td><td>${row.firstLine ? row.settlementKnown ? currency(row.sale.status === "dibatalkan" ? refundDue : outstanding) : "Tidak tersedia (historis)" : "—"}</td><td>${row.firstLine ? escapeHtml(row.sale.status_pembayaran || "Status tidak tersedia") : "—"}</td><td>${row.firstLine ? escapeHtml(row.sale.status || "—") : "—"}</td><td>${row.firstLine ? `<div class="actions"><button class="table-action" data-print-sale="${escapeHtml(row.sale.id)}" title="Cetak nota"><i class="fa-solid fa-print"></i></button>${paymentAction}${refundAction}${!row.sale.recipient_name && !["dibatalkan", "gagal_dikirim"].includes(row.sale.status) ? `<button class="table-action danger" data-cancel-sale="${escapeHtml(row.sale.id)}" title="Batalkan transaksi"><i class="fa-solid fa-rotate-left"></i></button>` : ""}</div>` : ""}</td></tr>`;
      },
      "Belum ada penjualan pada periode ini");

    const productNode = document.querySelector("#productPerformance");
    if (productNode) productNode.innerHTML = table(model.productTotals,
      ["SKU", "Barang", "Qty terjual", "Penjualan setelah alokasi diskon", "HPP", "Laba kotor"],
      row => `<tr><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.name)}</td><td>${row.quantity}</td><td>${currency(row.net)}</td><td>${row.costComplete ? currency(row.cost) : "Tidak tersedia"}</td><td>${row.margin === null ? "Tidak tersedia" : currency(row.margin)}</td></tr>`,
      "Belum ada detail barang terjual");

    const expensesByCategory = new Map();
    for (const expense of model.expenses) {
      const category = expense.kategori || "Lainnya";
      expensesByCategory.set(category, (expensesByCategory.get(category) || 0) + Number(expense.nominal || 0));
    }
    const categoryNode = document.querySelector("#expenseBreakdown");
    if (categoryNode) categoryNode.innerHTML = table([...expensesByCategory.entries()],
      ["Kategori", "Total beban tercatat"], row => `<tr><td>${escapeHtml(row[0])}</td><td>${currency(row[1])}</td></tr>`,
      "Belum ada beban tercatat");
    const expensesNode = document.querySelector("#expensesTable");
    if (expensesNode) expensesNode.innerHTML = table(model.expenses,
      ["Tanggal", "Kategori", "Keterangan", "Jumlah", "Dibayar", "Sisa utang", "Aksi"],
      row => {
        const settlementKnown = row.paid_amount != null;
        const paid = Number(row.paid_amount || 0);
        const outstanding = settlementKnown ? Math.max(0,Number(row.nominal)-paid) : null;
        return `<tr><td>${escapeHtml(dateLabel(row.tanggal || row.created_at))}</td><td>${escapeHtml(row.kategori)}</td><td>${escapeHtml(row.keterangan)}</td><td>${currency(row.nominal)}</td><td>${settlementKnown ? currency(paid) : "Tidak tersedia (historis)"}</td><td>${settlementKnown ? currency(outstanding) : "Tidak tersedia (historis)"}</td><td><div class="actions">${settlementKnown&&outstanding>0&&!accounting.error?`<button class="table-action" data-record-obligation-payment="expense_payment" data-obligation-id="${escapeHtml(row.id)}" data-payment-balance="${outstanding}" title="Bayar utang beban"><i class="fa-solid fa-money-bill-transfer"></i></button>`:""}<button class="table-action danger" data-delete-expense="${escapeHtml(row.id)}" title="Hapus beban"><i class="fa-solid fa-trash"></i></button></div></td></tr>`;
      },
      "Belum ada beban pada periode ini");
    const purchasesNode = document.querySelector("#purchasesTable");
    if (purchasesNode) purchasesNode.innerHTML = table(model.purchases,
      ["Tanggal", "Barang", "Jumlah", "Harga satuan", "Total", "Dibayar", "Sisa utang", "Catatan", "Aksi"],
      row => {
        const product = source.products.find(item => String(item.id) === String(row.barang_id));
        const total = Number(row.total ?? Number(row.jumlah || 0) * Number(row.harga_satuan || 0));
        const settlementKnown = row.paid_amount != null;
        const paid = Number(row.paid_amount || 0);
        const outstanding = settlementKnown ? Math.max(0,total-paid) : null;
        return `<tr><td>${escapeHtml(dateLabel(row.tanggal || row.created_at))}</td><td>${escapeHtml(product?.nama || "Barang")}</td><td>${Number(row.jumlah || 0)} ${escapeHtml(product?.satuan || "")}</td><td>${currency(row.harga_satuan)}</td><td>${currency(total)}</td><td>${settlementKnown ? currency(paid) : "Tidak tersedia (historis)"}</td><td>${settlementKnown ? currency(outstanding) : "Tidak tersedia (historis)"}</td><td>${escapeHtml(row.catatan || "—")}</td><td>${settlementKnown&&outstanding>0&&!accounting.error?`<button class="table-action" data-record-obligation-payment="supplier_payment" data-obligation-id="${escapeHtml(row.id)}" data-payment-balance="${outstanding}" title="Bayar utang pemasok"><i class="fa-solid fa-money-bill-transfer"></i></button>`:"—"}</td></tr>`;
      },
      "Belum ada stok masuk pada periode ini");
    const inventoryNode = document.querySelector("#inventoryValuation");
    if (inventoryNode) inventoryNode.innerHTML = table(model.products,
      ["SKU", "Barang", "Kategori", "Satuan", "Stok saat ini", "Biaya rata-rata tercatat", "Nilai saat ini", "Stok minimum", "Status"],
      row => `<tr><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.nama)}</td><td>${escapeHtml(row.kategori)}</td><td>${escapeHtml(row.satuan)}</td><td>${Number(row.stok || 0)}</td><td>${currency(row.harga_beli)}</td><td>${currency(row.value)}</td><td>${Number(row.stok_minimum || 0)}</td><td>${Number(row.stok) <= Number(row.stok_minimum) ? "Menipis" : "Aman"}</td></tr>`,
      "Belum ada data barang");
    const movementsNode = document.querySelector("#stockMovementsTable");
    if (movementsNode) movementsNode.innerHTML = table(model.movements,
      ["Tanggal", "Barang", "Jenis", "Referensi", "Masuk", "Keluar", "Stok setelah", "Catatan"],
      row => {
        const product = source.products.find(item => String(item.id) === String(row.barang_id));
        return `<tr><td>${escapeHtml(dateLabel(row.tanggal || row.created_at))}</td><td>${escapeHtml(product?.nama || row.barang_id || "Barang")}</td><td>${escapeHtml(row.tipe)}</td><td>${escapeHtml(row.referensi || "—")}</td><td>${Number(row.qty_masuk || 0)}</td><td>${Number(row.qty_keluar || 0)}</td><td>${Number(row.stok_setelah || 0)} ${escapeHtml(product?.satuan || "")}</td><td>${escapeHtml(row.catatan || "—")}</td></tr>`;
      },
      "Belum ada mutasi persediaan pada periode ini");
  }

  function setPreset(value) {
    const now = new Date();
    const today = dateInStoreZone(now);
    const [year, month, day] = today.split("-").map(Number);
    const local = new Date(Date.UTC(year, month - 1, day));
    let from = "", to = "";
    if (value === "today") from = to = today;
    if (value === "yesterday") {
      local.setUTCDate(local.getUTCDate() - 1);
      from = to = local.toISOString().slice(0, 10);
    }
    if (value === "this-week") {
      const weekday = (local.getUTCDay() + 6) % 7;
      local.setUTCDate(local.getUTCDate() - weekday);
      from = local.toISOString().slice(0, 10);
      to = today;
    }
    if (value === "this-month") {
      from = `${year}-${String(month).padStart(2, "0")}-01`;
      to = today;
    }
    if (value === "last-month") {
      const first = new Date(Date.UTC(year, month - 2, 1));
      const last = new Date(Date.UTC(year, month - 1, 0));
      from = first.toISOString().slice(0, 10);
      to = last.toISOString().slice(0, 10);
    }
    if (value === "this-year") {
      from = `${year}-01-01`;
      to = today;
    }
    document.querySelector("#reportFrom").value = from;
    document.querySelector("#reportTo").value = to;
  }

  function setActiveTab(button) {
    const target = document.querySelector(button.dataset.reportTarget);
    if (!target) return;
    activeTab = button.dataset.reportSheet || "Ringkasan";
    document.querySelectorAll("[data-report-target]").forEach(item => item.classList.toggle("active", item === button));
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function mount() {
    const page = document.querySelector("#page-reports");
    if (!page || page.dataset.financialReportsMounted) return;
    page.dataset.financialReportsMounted = "true";
    const header = page.querySelector(".page-title");
    if (header) {
      const actions = header.querySelector(".page-actions");
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.id = "reportRefresh";
      refresh.className = "btn-secondary";
      refresh.innerHTML = '<i class="fa-solid fa-rotate"></i> Muat ulang';
      const print = document.createElement("button");
      print.type = "button";
      print.id = "reportPrint";
      print.className = "btn-secondary";
      print.innerHTML = '<i class="fa-solid fa-print"></i> Cetak';
      const packageExport = document.createElement("button");
      packageExport.type = "button";
      packageExport.id = "exportPackageExcel";
      packageExport.className = "btn-primary";
      packageExport.innerHTML = '<i class="fa-solid fa-file-excel"></i> Ekspor paket (.xlsx)';
      const opening = document.createElement("button");
      opening.type = "button";
      opening.id = "openOpeningBalances";
      opening.className = "btn-secondary";
      opening.textContent = "Saldo awal";
      const journal = document.createElement("button");
      journal.type = "button";
      journal.id = "openManualJournal";
      journal.className = "btn-secondary";
      journal.textContent = "Jurnal manual";
      const reconciliation = document.createElement("button");
      reconciliation.type = "button";
      reconciliation.id = "openCashReconciliation";
      reconciliation.className = "btn-secondary";
      reconciliation.textContent = "Rekonsiliasi kas/bank";
      if (actions) {
          const csvExport = actions.querySelector("#exportSales");
          if (csvExport) csvExport.innerHTML = '<i class="fa-solid fa-file-csv"></i> Ekspor bagian aktif (.csv)';
          const reportExport = actions.querySelector("#exportSalesExcel");
          reportExport?.classList.replace("btn-primary", "btn-secondary");
          if (reportExport) reportExport.innerHTML = '<i class="fa-solid fa-file-excel"></i> Ekspor laporan (.xlsx)';
        actions.append(opening, journal, reconciliation, refresh, print, packageExport);
      }
    }
    const oldNotice = page.querySelector(".demo-data-notice:not(#legacyCostNotice):not(#reportDataError)");
    if (oldNotice) oldNotice.innerHTML = '<i class="fa-solid fa-circle-info"></i><span>Jurnal akuntansi dimulai pada tanggal cutover. Data lama tidak direkonstruksi karena riwayat pembayaran dan saldo awal tidak tersedia. Lengkapi dan verifikasi saldo awal sebelum memakai neraca. QRIS/kartu debit dicatat ke Bank pada tanggal transaksi sesuai kebijakan cutover; konfirmasi dengan mutasi bank Anda. Laporan tetap menampilkan selisih rekonsiliasi dan batas data.</span>';
    const revenueStat = page.querySelector("#reportRevenue")?.closest(".stat");
    if (revenueStat) revenueStat.querySelector(".stat-head span:last-child").textContent = "Penjualan tercatat setelah diskon";
    const purchaseStat = page.querySelector("#reportPurchases")?.closest(".stat");
    if (purchaseStat) purchaseStat.querySelector("small").textContent = "Status pembayaran baru dicatat setelah cutover";
    const cashStat = page.querySelector("#reportCashflow")?.closest(".stat");
    if (cashStat) {
      cashStat.querySelector(".stat-head span:last-child").textContent = "Arus kas";
      cashStat.querySelector("small").textContent = "Dihitung dari jurnal kas/bank; saldo awal perlu diverifikasi";
    }
    const paymentHeading = page.querySelector("#paymentBreakdown")?.closest(".panel")?.querySelector(".panel-head p");
    if (paymentHeading) paymentHeading.textContent = "Penerimaan dan pembayaran aktual yang tercatat ke akun kas/bank.";
    if (!page.querySelector("#reportDataError")) {
      const errorNotice = document.createElement("div");
      errorNotice.id = "reportDataError";
      errorNotice.className = "demo-data-notice hidden";
      errorNotice.setAttribute("role", "alert");
      header?.insertAdjacentElement("afterend", errorNotice);
    }
    const filterToolbar = page.querySelector(".report-toolbar");
    if (filterToolbar && !document.querySelector("#reportPreset")) {
      const label = document.createElement("label");
      label.className = "date-field";
      label.innerHTML = '<span>Periode cepat</span><select id="reportPreset" class="control"><option value="custom">Rentang tanggal</option><option value="today">Hari ini</option><option value="yesterday">Kemarin</option><option value="this-week">Minggu ini</option><option value="this-month">Bulan ini</option><option value="last-month">Bulan sebelumnya</option><option value="this-year">Tahun ini</option></select>';
      filterToolbar.prepend(label);
      const period = document.createElement("p");
      period.id = "reportPeriodLabel";
      period.className = "report-period";
      filterToolbar.parentElement.append(period);
      const filterNote = document.createElement("p");
      filterNote.id = "reportFilterNote";
      filterNote.className = "report-period";
      filterToolbar.parentElement.append(filterNote);
    }
    if (filterToolbar && !document.querySelector("#reportProductFilter")) {
      const filters = [
        ["reportProductFilter", "Barang"],
        ["reportCategoryFilter", "Kategori"],
        ["reportCustomerFilter", "Pelanggan"],
        ["reportPaymentFilter", "Metode pembayaran"],
        ["reportStatusFilter", "Status transaksi"]
      ];
      for (const [id, labelText] of filters) {
        const label = document.createElement("label");
        label.className = "date-field report-select-field";
        label.innerHTML = `<span>${labelText}</span><select id="${id}" class="control"><option value="">Semua</option></select>`;
        filterToolbar.append(label);
      }
      const unavailable = document.createElement("span");
      unavailable.className = "report-filter-unavailable";
      unavailable.textContent = "Filter kasir: belum tersedia pada skema";
      filterToolbar.append(unavailable);
    }
    const totals = page.querySelector(".report-totals");
    if (totals && !document.querySelector(".report-tabs")) {
      const tabs = document.createElement("nav");
      tabs.className = "report-tabs";
      tabs.setAttribute("aria-label", "Bagian laporan");
      tabs.innerHTML = [
        ["report-dashboard", "Dashboard", "Ringkasan"],
        ["incomeStatement", "Laba rugi", "Laba Rugi"],
        ["cashFlowStatement", "Arus kas", "Arus Kas"],
        ["balanceSheet", "Neraca", "Neraca"],
        ["accountingReconciliation", "Rekonsiliasi", "Rekonsiliasi"],
        ["inventoryValuation", "Persediaan", "Persediaan"],
        ["purchasesTable", "Pembelian", "Pembelian Stok"],
        ["salesTable", "Penjualan", "Penjualan"],
        ["expensesTable", "Beban", "Beban Operasional"],
        ["paymentBreakdown", "Pembayaran", "Pembayaran"]
      ].map(([target, label, sheet], index) => `<button type="button" class="${index === 0 ? "active" : ""}" data-report-target="#${target}" data-report-sheet="${sheet}">${label}</button>`).join("");
      totals.parentElement.insertBefore(tabs, totals);
      totals.id = "report-dashboard";
      const additionalMetrics = document.createElement("div");
      additionalMetrics.className = "report-totals stats section-gap";
      additionalMetrics.innerHTML = '<article class="stat"><div class="stat-head"><span>Penjualan bruto</span></div><b id="reportGrossSales">—</b><small>Subtotal sebelum diskon</small></article><article class="stat"><div class="stat-head"><span>Rata-rata transaksi selesai</span></div><b id="reportAverage">—</b><small>Nilai transaksi tercatat setelah diskon</small></article><article class="stat"><div class="stat-head"><span>Transaksi dibatalkan</span></div><b id="reportCanceledCount">—</b><small>Ditampilkan terpisah, tidak masuk penjualan</small></article><article class="stat"><div class="stat-head"><span>Nilai persediaan saat ini</span></div><b id="reportInventoryValue">—</b><small>Bukan nilai saldo historis</small></article><article class="stat"><div class="stat-head"><span>Retur / refund</span></div><b>Tidak tersedia</b><small>Tidak ada sumber data retur</small></article>';
      totals.insertAdjacentElement("afterend", additionalMetrics);
      const addStatement = (id, heading, content, after) => {
        const section = document.createElement("article");
        section.id = id;
        section.className = "panel section-gap";
        section.innerHTML = `<div class="panel-head"><div><h2>${heading}</h2><p>${content}</p></div></div><div id="${id}Table" class="table-scroll"></div><div id="${id}Warning" class="report-limitation section-gap hidden"></div>`;
        after.insertAdjacentElement("afterend", section);
        return section;
      };
      const income = page.querySelector("#incomeStatement")?.closest(".panel");
      const cash = addStatement("cashFlowStatement", "Laporan arus kas", "Mutasi kas dan bank dari jurnal pembayaran; QRIS/kartu debit diasumsikan masuk bank pada tanggal transaksi.", income || totals);
      const balance = addStatement("balanceSheet", "Neraca", "Saldo akun per akhir periode; laporan ditandai belum lengkap sampai saldo awal diverifikasi.", cash);
      addStatement("accountingReconciliation", "Rekonsiliasi", "Periksa keseimbangan jurnal, saldo persediaan, mutasi pembayaran, serta saldo kas/bank dibandingkan rekening koran.", balance);
      const tabTargets = tabs.querySelectorAll("[data-report-target]");
      tabTargets.forEach(button => {
        const target = page.querySelector(button.dataset.reportTarget);
        const section = target?.closest(".panel") || target;
        if (section && button.dataset.reportTarget !== "#report-dashboard") section.classList.add("report-section-anchor");
      });
    }
  }

  function sheetRows(title, headers, rows) {
    return [
      ["TOKO BUDI SEMBAKO"],
      [title],
      [`Periode: ${lastModel.period.from || "Awal data"} s.d. ${lastModel.period.to || "Hari ini"} (${TIME_ZONE})`],
      [`Diekspor: ${new Date().toISOString()}`],
      [],
      headers,
      ...rows
    ];
  }

  function createWorkbookSheets() {
    const model = lastModel;
    const source = callbacks.getData();
    const salesDetailRows = model.sales.flatMap(sale => {
      const customer = source.customers.find(row => String(row.id) === String(sale.pelanggan_id));
      const details = model.detailsBySale.get(String(sale.id)) || [null];
      const selectedSubtotal = sum(details.filter(Boolean), detail =>
        Number(detail.subtotal ?? Number(detail.jumlah || 0) * Number(detail.harga_satuan || 0)));
      const allocatedDiscount = model.filters.product || model.filters.category
        ? (Number(sale.subtotal) > 0 ? roundMoney(Number(sale.diskon || 0) * selectedSubtotal / Number(sale.subtotal)) : 0)
        : Number(sale.diskon || 0);
      let discountAssigned = 0;
      return details.map((detail, index) => {
        const lineSubtotal = detail
          ? Number(detail.subtotal ?? Number(detail.jumlah || 0) * Number(detail.harga_satuan || 0))
          : 0;
        const lineDiscount = !detail ? 0 : index === details.length - 1
          ? allocatedDiscount - discountAssigned
          : selectedSubtotal > 0 ? roundMoney(allocatedDiscount * lineSubtotal / selectedSubtotal) : 0;
        discountAssigned += lineDiscount;
        const product = detail && source.products.find(row => String(row.id) === String(detail.barang_id));
        return [
          sale.nomor_nota, sale.tanggal, customer?.nama || sale.recipient_name || "Pelanggan umum",
          "Tidak tersedia", detail?.sku || "Tidak tersedia", detail?.nama_barang || "Tidak tersedia",
          detail ? Number(detail.jumlah) : "Tidak tersedia", product?.satuan || "Tidak tersedia",
          detail ? Number(detail.harga_satuan) : "Tidak tersedia",
          detail?.harga_pokok_satuan == null ? "Tidak tersedia" : Number(detail.harga_pokok_satuan),
          detail ? lineSubtotal : "Tidak tersedia", detail ? lineDiscount : "Tidak tersedia",
          detail ? lineSubtotal - lineDiscount : "Tidak tersedia",
          index === 0 ? Number(sale.subtotal || 0) : null,
          index === 0 ? Number(sale.diskon || 0) : null,
          index === 0 ? Number(sale.total || 0) : null,
          paymentLabel(sale.metode_pembayaran),
          index === 0 ? Number(sale.jumlah_dibayar || 0) : null,
          index === 0 ? Number(sale.kembalian || 0) : null,
          sale.status_pembayaran || "Tidak tersedia", sale.status
        ];
      });
    });
    const expenseRows = model.expenses.map(row => [
      row.tanggal, row.id, row.kategori, row.keterangan, Number(row.nominal), "Tidak tersedia"
    ]);
    const inventoryRows = model.products.map(row => [
      row.sku, row.nama, row.kategori, row.satuan, Number(row.stok), Number(row.harga_beli),
      row.value, Number(row.stok_minimum), Number(row.stok) <= Number(row.stok_minimum) ? "Menipis" : "Aman"
    ]);
    const movementRows = model.movements.map(row => {
      const product = source.products.find(item => String(item.id) === String(row.barang_id));
      return [row.tanggal, product?.sku || "", product?.nama || "", row.tipe, row.referensi,
        Number(row.qty_masuk), Number(row.qty_keluar), Number(row.stok_setelah), row.catatan];
    });
    const purchaseRows = model.purchases.map(row => {
      const product = source.products.find(item => String(item.id) === String(row.barang_id));
      const total = Number(row.total ?? Number(row.jumlah || 0) * Number(row.harga_satuan || 0));
      const settlementKnown = row.paid_amount != null;
      const paid = Number(row.paid_amount || 0);
      return [row.tanggal, product?.sku || "", product?.nama || "", Number(row.jumlah),
        Number(row.harga_satuan), total,
        settlementKnown ? paid : "Tidak tersedia (historis)",
        settlementKnown ? Math.max(0,total-paid) : "Tidak tersedia (historis)",
        paymentLabel(row.payment_method), row.catatan];
    });
    const pnl = [
      ["Penjualan bruto", model.subtotal], ["Diskon penjualan", -model.discount],
      ["Retur/refund", "Tidak tersedia"], ["Penjualan tercatat setelah diskon (belum dikurangi retur)", model.netSales],
      ["HPP", model.cogs === null ? "Tidak tersedia" : -model.cogs],
      ["Laba kotor tercatat", model.grossProfit === null ? "Tidak tersedia" : model.grossProfit],
      [model.salesFiltered ? "Beban periode (tidak dialokasikan ke filter penjualan)" : "Beban operasional tercatat",
        model.salesFiltered ? "Tidak tersedia untuk alokasi" : -model.expenseTotal],
      ["Laba bersih tercatat sebelum pajak", model.netProfit === null ? "Tidak tersedia" : model.netProfit],
      ["Pendapatan/beban nonoperasional", "Tidak tersedia"], ["Pajak penghasilan", "Tidak tersedia"]
    ];
    const ledger = model.accounting.error ? null : model.accounting;
    const ledgerPnl = ledger
      ? [...ledger.profitAndLossRows.map(row => [row.code, row.name, row.amount]),
        ["", "Laba/rugi bersih jurnal pada periode", sum(ledger.profitAndLossRows, row => row.amount)]]
      : [["", "Migrasi ledger belum diterapkan", "Tidak tersedia"]];
    const cashFlowRows = ledger ? [
      ["Saldo kas/bank awal", ledger.openingCash ?? "Saldo awal belum tersedia", "", ""],
      ...ledger.activityRows.map(row => [
        ({ operating: "Operasi", investing: "Investasi", financing: "Pendanaan" })[row.activity],
        row.inflow, row.outflow, row.net
      ]),
      ["Perubahan kas/bank", "", "", ledger.netCashChange],
      ["Saldo kas/bank akhir", ledger.cashEnding ?? "Saldo awal belum tersedia", "", ""],
      ...ledger.cashByMethod.map(row => [`Metode: ${paymentLabel(row.method)}`, row.inflow, row.outflow, row.inflow-row.outflow])
    ] : [["", "Migrasi ledger belum diterapkan", "Tidak tersedia", "Tidak tersedia"]];
    const balanceSheetRows = ledger ? [
      ...ledger.assets.map(row => ["Aset", row.code, row.name, row.amount]),
      ["", "", "TOTAL ASET", ledger.assetTotal],
      ...ledger.liabilities.map(row => ["Liabilitas", row.code, row.name, row.amount]),
      ["", "", "TOTAL LIABILITAS", ledger.liabilityTotal],
      ...ledger.equityAccounts.map(row => ["Ekuitas", row.code, row.name, row.amount]),
      ["Ekuitas", "", "Laba/rugi kumulatif setelah cutover", ledger.profitToDate],
      ["", "", "TOTAL LIABILITAS + EKUITAS", ledger.liabilityTotal+ledger.equityTotal],
      ["", "", "SELISIH NERACA", ledger.balanceDifference]
    ] : [["", "", "Migrasi ledger belum diterapkan", "Tidak tersedia"]];
    const reconciliationRows = ledger ? [
      ["Saldo awal", ledger.hasOpening ? "Tersedia" : "Belum dicatat"],
      ["Keseimbangan jurnal", ledger.allBalanced ? "Seimbang" : "TIDAK SEIMBANG"],
      ["Selisih neraca", ledger.balanceDifference],
      ["Selisih posting pembayaran", ledger.paymentPostingDifference],
      ["Nilai persediaan pada buku", ledger.inventoryLedger ?? "Tidak tersedia"],
      ["Estimasi stok saat ini", ledger.inventoryComparable ? ledger.inventoryActual : "Tanggal laporan bukan hari ini"],
      ["Selisih persediaan", ledger.inventoryDifference ?? "Belum dapat dibandingkan"],
      ...ledger.reconciliationRows.map(row => [
        `Kas/bank ${row.account}`,
        row.statementDate === ledger.endDate && row.difference !== null
          ? `Selisih ${row.difference}` : `Belum cocok pada ${ledger.endDate}`
      ])
    ] : [["Migrasi ledger", model.accounting.error]];
    const paymentRows = ledger ? ledger.payments.filter(payment =>
      payment.payment_date >= ledger.startDate && payment.payment_date <= ledger.endDate
    ).map(payment => [
      payment.payment_date, payment.kind, payment.payment_method, payment.amount,
      payment.source_id, payment.journal_entry_id
    ]) : [["", "Riwayat pembayaran belum tersedia", "", "", "", ""]];
    const current = [
      { name: activeTab === "Ringkasan" ? "Ringkasan" : activeTab, rows: sheetRows(`${activeTab} — Toko Budi Sembako`, ["Indikator", "Nilai"], [
        ["Jumlah transaksi selesai", model.completed.length], ["Penjualan bruto", model.subtotal],
        ["Diskon", model.discount], ["Penjualan setelah diskon (belum dikurangi retur)", model.netSales ?? "Tidak tersedia"],
        ["HPP operasional", model.cogs ?? "Tidak tersedia"], ["Arus kas bersih jurnal", ledger?.netCashChange ?? "Tidak tersedia"],
        ["Saldo kas/bank akhir", ledger?.cashEnding ?? "Saldo awal belum tersedia"],
        ["Total aset", ledger?.assetTotal ?? "Tidak tersedia"], ["Total liabilitas + ekuitas", ledger ? ledger.liabilityTotal+ledger.equityTotal : "Tidak tersedia"],
        ["Laba/rugi dari jurnal", ledger ? sum(ledger.profitAndLossRows,row=>row.amount) : "Tidak tersedia"],
        ["Saldo persediaan buku", ledger?.inventoryLedger ?? "Tidak tersedia"],
        ["Valuasi stok saat ini", ledger?.inventoryActual ?? model.inventoryTotal]
      ]) }
    ];
    const all = [
      { name: "Ringkasan", rows: sheetRows("Ringkasan Keuangan", ["Indikator", "Nilai"], [
        ["Jumlah transaksi selesai", model.completed.length], ["Jumlah transaksi dibatalkan/tertunda", model.sales.length - model.completed.length],
        ["Penjualan bruto", model.subtotal], ["Diskon", model.discount],
        ["Penjualan setelah diskon (belum dikurangi retur)", model.netSales ?? "Tidak tersedia"], ["HPP", model.cogs ?? "Tidak tersedia"],
        ["Laba/rugi bersih dari jurnal", ledger ? sum(ledger.profitAndLossRows,row=>row.amount) : "Migrasi belum diterapkan"],
        ["Retur/refund historis", "Tidak direkonstruksi"],
        ["Perubahan kas/bank jurnal", ledger?.netCashChange ?? "Tidak tersedia"],
        ["Saldo kas/bank akhir", ledger?.cashEnding ?? "Saldo awal belum dicatat"],
        ["Total aset", ledger?.assetTotal ?? "Tidak tersedia"],
        ["Total liabilitas + ekuitas", ledger ? ledger.liabilityTotal+ledger.equityTotal : "Tidak tersedia"],
        ["Selisih neraca", ledger?.balanceDifference ?? "Tidak tersedia"],
        ["Tanggal cutover", ledger?.cutoverDate ?? "Migrasi belum diterapkan"],
        ["Saldo awal", ledger?.hasOpening ? "Sudah dicatat" : "Belum diverifikasi"]
      ]) },
      { name: "Laba Rugi", rows: sheetRows(ledger ? "Laba Rugi dari Jurnal" : "Laba Rugi Operasional (Provisional)", ledger ? ["Kode", "Akun", "Nominal (Rp)"] : ["Keterangan", "Nominal (Rp)"], ledger ? ledgerPnl : pnl) },
      { name: "Arus Kas", rows: sheetRows("Arus Kas Jurnal Kas dan Bank", ["Aktivitas / Metode", "Kas masuk (Rp)", "Kas keluar (Rp)", "Neto (Rp)"], cashFlowRows) },
      { name: "Neraca", rows: sheetRows("Neraca per Akhir Periode", ["Kelompok", "Kode", "Akun", "Saldo (Rp)"], balanceSheetRows) },
      { name: "Persediaan", rows: sheetRows("Valuasi Stok Saat Ini (Bukan Historis)", [
        "SKU", "Nama barang", "Kategori", "Satuan", "Stok saat ini", "Biaya rata-rata tercatat (Rp)", "Nilai saat ini (Rp)", "Stok minimum", "Status"
      ], inventoryRows) },
      { name: "Pembelian Stok", rows: sheetRows("Pembelian dan Status Pembayaran", [
        "Tanggal", "SKU", "Nama barang", "Jumlah", "Harga satuan (Rp)", "Total (Rp)",
        "Dibayar (Rp)", "Sisa utang (Rp)", "Metode", "Catatan"
      ], purchaseRows) },
      { name: "Penjualan", rows: sheetRows("Penjualan dan Detail Barang", [
        "Nomor nota", "Tanggal", "Pelanggan", "Kasir", "SKU", "Produk", "Kuantitas", "Satuan",
        "Harga satuan (Rp)", "HPP snapshot satuan (Rp)", "Subtotal baris (Rp)", "Diskon alokasi baris (Rp)",
        "Penjualan bersih baris (Rp)", "Subtotal nota (Rp)", "Diskon nota (Rp)", "Total nota (Rp)",
        "Metode", "Dibayar pada nota (Rp)", "Kembalian (Rp)", "Status pembayaran", "Status transaksi"
      ], salesDetailRows) },
      { name: "Beban Operasional", rows: sheetRows("Beban dan Pembayaran Tercatat", [
        "Tanggal", "ID bukti", "Kategori", "Keterangan", "Nominal (Rp)", "Dibayar (Rp)", "Sisa utang (Rp)", "Metode"
      ], model.expenses.map(row => [
        row.tanggal, row.id, row.kategori, row.keterangan, Number(row.nominal),
        row.paid_amount == null ? "Tidak tersedia (historis)" : Number(row.paid_amount),
        row.paid_amount == null ? "Tidak tersedia (historis)" : Math.max(0,Number(row.nominal)-Number(row.paid_amount)),
        paymentLabel(row.payment_method)
      ])) },
      { name: "Pembayaran", rows: sheetRows("Mutasi Pembayaran Jurnal (Tunai dan Bank)", [
        "Tanggal", "Jenis", "Metode", "Nominal (Rp)", "Sumber transaksi", "ID jurnal"
      ], paymentRows) },
      { name: "Rekonsiliasi", rows: sheetRows("Rekonsiliasi", ["Pemeriksaan", "Nilai / Status"], reconciliationRows.concat([
        ["Jurnal seimbang", ledger?.allBalanced ? "Ya" : "Tidak / belum diuji"],
        ["Saldo awal historis", ledger?.hasOpening ? "Tercatat pada cutover" : "Belum ada; angka neraca belum lengkap"],
        ["Asumsi QRIS/kartu", "Dicatat sebagai Bank pada tanggal transaksi"],
        ["Transaksi historis sebelum cutover", "Tidak direkonstruksi"]
      ])) },
      { name: "Metadata", rows: sheetRows("Metadata Ekspor", ["Kolom", "Nilai"], [
        ["Nama toko", "Toko Budi Sembako"], ["Tanggal mulai", model.period.from || "Awal data"],
        ["Tanggal akhir", model.period.to || "Hari ini"], ["Zona waktu", TIME_ZONE],
        ["Tanggal ekspor UTC", new Date().toISOString()],
        ["Tanggal cutover akuntansi", ledger?.cutoverDate ?? "Migrasi belum diterapkan"],
        ["Tanggal awal laporan jurnal", ledger?.startDate ?? "Tidak tersedia"],
        ["Asumsi pembayaran digital", "QRIS dan kartu debit dianggap masuk Bank pada tanggal transaksi; rekonsiliasi bank tetap diperlukan"],
        ["Data historis sebelum cutover", "Tidak diimpor; membutuhkan saldo awal dan dokumen sumber terverifikasi"],
        ["Status saldo awal", ledger?.hasOpening ? "Dimasukkan Owner" : "Belum dicatat"]
      ]) }
    ];
    return { current, all };
  }

  function exportWorkbook(packageExport) {
    if (!lastModel || loadError) throw new Error("Data laporan belum siap. Muat ulang laporan dan coba lagi.");
    if (!window.XLSX?.utils || typeof window.XLSX.writeFile !== "function") {
      throw new Error("Library Excel tidak tersedia. Periksa koneksi internet, lalu muat ulang halaman.");
    }
    const sheets = createWorkbookSheets();
    const chosen = packageExport ? sheets.all : [sheets.all.find(sheet => sheet.name === activeTab) || sheets.current[0]];
    const workbook = window.XLSX.utils.book_new();
    for (const sheet of chosen) {
      const headers = sheet.rows[5] || [];
      const dateColumns = new Set(headers.map((header, index) =>
        /date|tanggal/i.test(String(header || "")) && !/utc/i.test(String(header || "")) ? index : -1
      ).filter(index => index >= 0));
      const rows = sheet.rows.map((row, rowIndex) => row.map((value, columnIndex) => {
        if (rowIndex >= 6 && dateColumns.has(columnIndex) &&
            typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) {
          return excelDateSerial(value);
        }
        return typeof value === "string" ? textCell(value) : value;
      }));
      const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
      const headerLine = 6;
      const titleStyle = { font: { name: "Aptos Display", sz: 16, bold: true, color: { rgb: "244C3A" } } };
      const subtitleStyle = { font: { name: "Aptos", sz: 12, bold: true, color: { rgb: "244C3A" } } };
      const headerStyle = {
        font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
        fill: { patternType: "solid", fgColor: { rgb: "386B52" } },
        alignment: { vertical: "center", wrapText: true }
      };
      if (worksheet.A1) worksheet.A1.s = titleStyle;
      if (worksheet.A2) worksheet.A2.s = subtitleStyle;
      rows[headerLine - 1].forEach((_, columnIndex) => {
        const cell = worksheet[window.XLSX.utils.encode_cell({ r: headerLine - 1, c: columnIndex })];
        if (cell) cell.s = headerStyle;
      });
      worksheet["!cols"] = rows[headerLine - 1].map((_, index) => ({
        wch: Math.min(42, Math.max(12, ...rows.slice(headerLine).map(row => String(row[index] ?? "").length + 2)))
      }));
      if (rows.length > headerLine) worksheet["!autofilter"] = {
        ref: `A${headerLine}:${window.XLSX.utils.encode_col(rows[headerLine - 1].length - 1)}${rows.length}`
      };
      for (let rowIndex = headerLine; rowIndex < rows.length; rowIndex++) {
        for (let columnIndex = 0; columnIndex < rows[rowIndex].length; columnIndex++) {
          const cell = worksheet[window.XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
          if (cell && typeof cell.v === "number") {
            const header = String(rows[headerLine - 1][columnIndex] || "");
            const rowLabel = String(rows[rowIndex][0] || "");
            const originalValue = sheet.rows[rowIndex]?.[columnIndex];
            if (dateColumns.has(columnIndex) && typeof originalValue === "string" &&
                /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(originalValue)) {
              cell.z = originalValue.includes("T") ? "dd/mm/yyyy hh:mm" : "dd/mm/yyyy";
              cell.s = { ...(cell.s || {}), numFmt: cell.z, alignment: { horizontal: "center" } };
              continue;
            }
            const currencyValue = /rp|nominal|diskon|penjualan|hpp|laba|nilai|biaya|beban|total|saldo|kas|arus|selisih|debit|kredit/i.test(`${header} ${rowLabel}`);
            cell.z = currencyValue
              ? '"Rp" #,##0;[Red]("Rp" #,##0);-'
              : '#,##0.###;[Red](#,##0.###);-';
            cell.s = { ...(cell.s || {}), numFmt: cell.z, alignment: { horizontal: "right" } };
          }
        }
      }
      window.XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
    }
    const today = dateInStoreZone(new Date());
    window.XLSX.writeFile(workbook, `Laporan_Keuangan_Toko_Budi_${today}.xlsx`, { compression: true });
    callbacks.notify(packageExport ? "Paket laporan Excel berhasil dibuat." : "Laporan Excel berhasil dibuat.", false);
  }

  function exportCsv() {
    if (!lastModel || loadError || isLoading) throw new Error("Data laporan belum siap. Muat ulang laporan dan coba lagi.");
    const sheets = createWorkbookSheets();
    const sheet = sheets.all.find(item => item.name === activeTab) || sheets.current[0];
    const contents = sheet.rows.map(row => row.map(value =>
      `"${textCell(value ?? "").replace(/"/g, '""')}"`
    ).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff", contents], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Laporan_Keuangan_Toko_Budi_${dateInStoreZone(new Date())}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    callbacks.notify("Bagian laporan aktif berhasil diekspor sebagai CSV.", false);
  }

  function setup(options) {
    callbacks = options;
    mount();
    document.querySelector("#reportPreset")?.addEventListener("change", event => {
      setPreset(event.target.value);
    });
    document.querySelector("#applyReport")?.addEventListener("click", () => {
      const period = currentPeriod();
      if (period.from && period.to && period.from > period.to) {
        callbacks.notify("Tanggal mulai tidak boleh setelah tanggal akhir.", true);
        return;
      }
      render(callbacks.getData());
    });
    document.querySelector("#resetReport")?.addEventListener("click", () => {
      document.querySelector("#reportFrom").value = "";
      document.querySelector("#reportTo").value = "";
      document.querySelector("#reportPreset").value = "custom";
      ["#reportProductFilter", "#reportCategoryFilter", "#reportCustomerFilter", "#reportPaymentFilter", "#reportStatusFilter"]
        .forEach(selector => { const input = document.querySelector(selector); if (input) input.value = ""; });
      render(callbacks.getData());
    });
    document.querySelector("#reportRefresh")?.addEventListener("click", async () => {
      const button = document.querySelector("#reportRefresh");
      button.disabled = true;
      try {
        await callbacks.refresh();
      } catch (error) {
        setReportError(error.message);
        callbacks.notify(`Laporan gagal dimuat: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
    document.querySelector("#reportPrint")?.addEventListener("click", () => window.print());
    document.querySelector("#exportSales")?.addEventListener("click", () => {
      try { exportCsv(); } catch (error) { callbacks.notify(error.message, true); }
    });
    document.querySelector("#exportSalesExcel")?.addEventListener("click", () => {
      try { exportWorkbook(false); } catch (error) { callbacks.notify(error.message, true); }
    });
    document.querySelector("#exportPackageExcel")?.addEventListener("click", () => {
      try { exportWorkbook(true); } catch (error) { callbacks.notify(error.message, true); }
    });
    document.querySelector(".report-tabs")?.addEventListener("click", event => {
      const button = event.target.closest("[data-report-target]");
      if (button) setActiveTab(button);
    });
    const period = currentPeriod();
    if (period.from && period.to && period.from > period.to) {
      document.querySelector("#reportFrom").value = "";
      document.querySelector("#reportTo").value = "";
    }
  }

  window.RetailFinancialReports = {
    setup,
    render,
    makeModel,
    makeAccountingModel,
    setLoading: setReportLoading,
    setError: setReportError,
    clearError() {
      loadError = "";
      isLoading = false;
      document.querySelector("#reportDataError")?.classList.add("hidden");
      ["#exportSales", "#exportSalesExcel", "#exportPackageExcel"].forEach(selector => {
        const button = document.querySelector(selector);
        if (button) button.disabled = false;
      });
    },
    getLastModel() { return lastModel; }
  };
})();
